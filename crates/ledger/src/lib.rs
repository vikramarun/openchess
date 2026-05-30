//! Settlement seam: takes the authoritative, server-produced game result and
//! settles it on the `ChessEscrow` contract on Base.
//!
//! The game server is the oracle: on a finished game it signs an EIP-712
//! `GameResult` and submits `settleGame`, which moves the locked stake from the
//! loser's bankroll to the winner's (minus rake). Funds live in the contract,
//! never in a platform wallet.

use alloy::primitives::{keccak256, B256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::network::EthereumWallet;
use alloy::signers::Signer;
use alloy::sol;
use alloy::sol_types::SolValue;
use async_trait::async_trait;
use uuid::Uuid;

// Bindings generated from the Foundry build artifacts (ABI + bytecode), so we
// can both call and (in tests) deploy the contracts.
sol!(
    #[sol(rpc)]
    ChessEscrow,
    "../../contracts/out/ChessEscrow.sol/ChessEscrow.json"
);

sol!(
    #[sol(rpc)]
    MockUSDC,
    "../../contracts/out/ChessEscrow.t.sol/MockUSDC.json"
);

// Re-exported so downstream crates (the server) don't depend on alloy directly.
pub use alloy::primitives::{Address, U256};
pub use alloy::signers::local::PrivateKeySigner;
use std::sync::Arc;

/// Build a settlement sink from the environment. If `RPC_URL`, `ESCROW_ADDR`,
/// and `ORACLE_KEY` are all set it returns an on-chain sink; otherwise it falls
/// back to the no-chain logging sink so the server still runs locally.
pub fn from_env() -> Arc<dyn SettlementSink> {
    let rpc = std::env::var("RPC_URL").ok();
    let addr = std::env::var("ESCROW_ADDR").ok();
    let key = std::env::var("ORACLE_KEY").ok();
    match (rpc, addr, key) {
        (Some(rpc), Some(addr), Some(key)) => {
            match (
                rpc.parse::<alloy::transports::http::reqwest::Url>(),
                addr.parse::<Address>(),
                key.parse::<PrivateKeySigner>(),
            ) {
                (Ok(url), Ok(escrow), Ok(oracle)) => {
                    tracing::info!(%escrow, "settlement: on-chain sink configured");
                    Arc::new(OnchainSettlement::new(url, escrow, oracle))
                }
                _ => {
                    tracing::warn!("settlement: bad RPC_URL/ESCROW_ADDR/ORACLE_KEY, using log sink");
                    Arc::new(LogSettlement)
                }
            }
        }
        _ => {
            tracing::info!("settlement: no chain config, using log sink");
            Arc::new(LogSettlement)
        }
    }
}

/// Recover the signer address of an EIP-191 `personal_sign` over `message`
/// (what wallets produce for Sign-In with Ethereum). `sig_hex` is the 65-byte
/// signature as a 0x-prefixed hex string.
pub fn recover_personal_sign(message: &str, sig_hex: &str) -> Option<Address> {
    let sig: alloy::primitives::Signature = sig_hex.parse().ok()?;
    sig.recover_address_from_msg(message).ok()
}

/// Map our 16-byte UUID game id into the contract's `bytes32` game id.
pub fn game_id_to_bytes32(id: Uuid) -> B256 {
    let mut b = [0u8; 32];
    b[..16].copy_from_slice(id.as_bytes());
    B256::from(b)
}

// --- Merkle tree (matches ChessEscrow._verifyProof: sorted-pair hashing,
// OZ-style double-hashed leaves) ------------------------------------------

/// Leaf for a tournament payout: keccak256(keccak256(abi.encode(account, amount))).
pub fn tournament_leaf(account: Address, amount: U256) -> B256 {
    let inner = keccak256((account, amount).abi_encode());
    keccak256(inner)
}

fn hash_pair(a: B256, b: B256) -> B256 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(lo.as_slice());
    buf[32..].copy_from_slice(hi.as_slice());
    keccak256(buf)
}

/// Merkle root over leaf hashes (odd node carried up unchanged).
pub fn merkle_root(leaves: &[B256]) -> B256 {
    if leaves.is_empty() {
        return B256::ZERO;
    }
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(hash_pair(level[i], level[i + 1]));
                i += 2;
            } else {
                next.push(level[i]);
                i += 1;
            }
        }
        level = next;
    }
    level[0]
}

/// Proof (sibling path) for the leaf at `index`.
pub fn merkle_proof(leaves: &[B256], mut index: usize) -> Vec<B256> {
    let mut proof = Vec::new();
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                if i == index {
                    proof.push(level[i + 1]);
                } else if i + 1 == index {
                    proof.push(level[i]);
                }
                next.push(hash_pair(level[i], level[i + 1]));
                i += 2;
            } else {
                next.push(level[i]); // odd carried up; no sibling for it
                i += 1;
            }
        }
        index /= 2;
        level = next;
    }
    proof
}

/// The settlement interface the game server depends on.
#[async_trait]
pub trait SettlementSink: Send + Sync {
    /// Lock both players' stakes for a game (called when a wagered game opens).
    async fn open_escrow(
        &self,
        game_id: Uuid,
        white: Address,
        black: Address,
        stake: U256,
    ) -> anyhow::Result<()>;

    /// Settle a finished game. `winner == None` is a draw (both refunded).
    async fn report_result(&self, game_id: Uuid, winner: Option<Address>)
        -> anyhow::Result<()>;

    /// Whether this sink actually settles on-chain. The server refuses wagered
    /// games when this is false (fail-closed — never take money it can't settle).
    fn is_onchain(&self) -> bool {
        false
    }

    /// Whether a game is already settled on-chain. Lets the settlement worker
    /// treat a crash-after-submit (or any replay revert) as success rather than
    /// a failure. Default `false` for non-chain sinks.
    async fn is_settled(&self, _game_id: Uuid) -> bool {
        false
    }

    // -- tournaments -------------------------------------------------------

    async fn open_tournament(&self, tid: Uuid, buy_in: U256) -> anyhow::Result<()> {
        tracing::info!(%tid, %buy_in, "settlement(log): open tournament");
        Ok(())
    }

    async fn enter_tournament(&self, tid: Uuid, player: Address) -> anyhow::Result<()> {
        tracing::info!(%tid, %player, "settlement(log): enter tournament");
        Ok(())
    }

    /// Distribute a tournament pool directly to a small winners list.
    async fn settle_tournament(
        &self,
        tid: Uuid,
        _players: Vec<Address>,
        _payouts: Vec<U256>,
    ) -> anyhow::Result<()> {
        tracing::info!(%tid, "settlement(log): settle tournament");
        Ok(())
    }

    /// Settle a large tournament by committing a Merkle root of the payout
    /// leaves; winners claim individually on-chain. Returns the committed root.
    async fn settle_tournament_root(
        &self,
        tid: Uuid,
        _leaves: Vec<(Address, U256)>,
    ) -> anyhow::Result<B256> {
        tracing::info!(%tid, "settlement(log): settle tournament (root)");
        Ok(B256::ZERO)
    }

    /// Whether a tournament is already settled on-chain (worker idempotency).
    async fn is_tournament_settled(&self, _tid: Uuid) -> bool {
        false
    }

    // -- verifiable results ------------------------------------------------

    /// Sign a result commitment (the game's `result_hash`) so clients can
    /// verify, non-repudiably, that the oracle attested this exact result.
    /// Returns a 0x-hex EIP-191 signature, or None if there is no signer.
    async fn sign_result(&self, _commitment: &str) -> Option<String> {
        None
    }

    /// The oracle/result-signer address (checksummed), if any. Published so
    /// clients can verify `sign_result` signatures.
    fn signer_address(&self) -> Option<String> {
        None
    }

    /// The escrow contract address (checksummed), if this sink settles on-chain.
    /// Published so the web app can wire deposits/withdrawals to the right
    /// contract without a second place to configure it.
    fn escrow_address(&self) -> Option<String> {
        None
    }
}

/// Default no-chain sink: logs what it *would* settle. Used when the server is
/// not configured with on-chain credentials (e.g. the local demo).
pub struct LogSettlement;

#[async_trait]
impl SettlementSink for LogSettlement {
    async fn open_escrow(
        &self,
        game_id: Uuid,
        white: Address,
        black: Address,
        stake: U256,
    ) -> anyhow::Result<()> {
        tracing::info!(%game_id, %white, %black, %stake, "settlement(log): open escrow");
        Ok(())
    }

    async fn report_result(
        &self,
        game_id: Uuid,
        winner: Option<Address>,
    ) -> anyhow::Result<()> {
        tracing::info!(%game_id, ?winner, "settlement(log): report result");
        Ok(())
    }
}

/// On-chain sink backed by the `ChessEscrow` contract on an EVM chain (Base /
/// Base Sepolia / local Anvil).
pub struct OnchainSettlement {
    provider: DynProvider,
    escrow: Address,
    oracle: PrivateKeySigner,
}

impl OnchainSettlement {
    /// Build from an RPC URL, the escrow address, and the oracle signer. The
    /// oracle key both sends the transactions and signs the EIP-712 result.
    pub fn new(
        rpc_url: alloy::transports::http::reqwest::Url,
        escrow: Address,
        oracle: PrivateKeySigner,
    ) -> Self {
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(oracle.clone()))
            .connect_http(rpc_url)
            .erased();
        OnchainSettlement {
            provider,
            escrow,
            oracle,
        }
    }

    fn contract(&self) -> ChessEscrow::ChessEscrowInstance<DynProvider> {
        ChessEscrow::new(self.escrow, self.provider.clone())
    }
}

#[async_trait]
impl SettlementSink for OnchainSettlement {
    async fn open_escrow(
        &self,
        game_id: Uuid,
        white: Address,
        black: Address,
        stake: U256,
    ) -> anyhow::Result<()> {
        if white == black {
            anyhow::bail!("refusing to open escrow with identical seats");
        }
        let gid = game_id_to_bytes32(game_id);
        let escrow = self.contract();
        escrow
            .openGame(gid, white, black, stake)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%game_id, %white, %black, %stake, "settlement(onchain): opened escrow");
        Ok(())
    }

    async fn report_result(
        &self,
        game_id: Uuid,
        winner: Option<Address>,
    ) -> anyhow::Result<()> {
        let gid = game_id_to_bytes32(game_id);
        let winner_addr = winner.unwrap_or(Address::ZERO);
        let escrow = self.contract();

        // Bound the signature's lifetime so a captured result can't be relayed
        // indefinitely.
        let deadline = U256::from(unix_now().saturating_add(3600));

        // Ask the contract for the exact EIP-712 digest, sign it with the
        // oracle key, and submit. (Signing the contract's own digest avoids
        // re-deriving the domain separator in Rust.)
        let digest = escrow.digestGameResult(gid, winner_addr, deadline).call().await?;
        let sig = self.oracle.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        let r = B256::from(sig.r());
        let s = B256::from(sig.s());

        escrow
            .settleGame(gid, winner_addr, deadline, v, r, s)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%game_id, ?winner, "settlement(onchain): settled");
        Ok(())
    }

    fn is_onchain(&self) -> bool {
        true
    }

    async fn is_settled(&self, game_id: Uuid) -> bool {
        let gid = game_id_to_bytes32(game_id);
        match self.contract().games(gid).call().await {
            Ok(g) => g.settled,
            Err(_) => false,
        }
    }

    async fn open_tournament(&self, tid: Uuid, buy_in: U256) -> anyhow::Result<()> {
        let tidb = game_id_to_bytes32(tid);
        self.contract()
            .openTournament(tidb, buy_in)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%tid, %buy_in, "settlement(onchain): opened tournament");
        Ok(())
    }

    async fn enter_tournament(&self, tid: Uuid, player: Address) -> anyhow::Result<()> {
        let tidb = game_id_to_bytes32(tid);
        self.contract()
            .enterTournament(tidb, player)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%tid, %player, "settlement(onchain): tournament entry");
        Ok(())
    }

    async fn settle_tournament(
        &self,
        tid: Uuid,
        players: Vec<Address>,
        payouts: Vec<U256>,
    ) -> anyhow::Result<()> {
        let tidb = game_id_to_bytes32(tid);
        let deadline = U256::from(unix_now().saturating_add(3600));
        let escrow = self.contract();
        let digest = escrow
            .digestTournamentResult(tidb, players.clone(), payouts.clone(), deadline)
            .call()
            .await?;
        let sig = self.oracle.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        let r = B256::from(sig.r());
        let s = B256::from(sig.s());
        escrow
            .settleTournament(tidb, players, payouts, deadline, v, r, s)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%tid, "settlement(onchain): tournament settled");
        Ok(())
    }

    async fn settle_tournament_root(
        &self,
        tid: Uuid,
        leaves: Vec<(Address, U256)>,
    ) -> anyhow::Result<B256> {
        let leaf_hashes: Vec<B256> =
            leaves.iter().map(|(a, amt)| tournament_leaf(*a, *amt)).collect();
        let root = merkle_root(&leaf_hashes);
        let total: U256 = leaves.iter().fold(U256::ZERO, |acc, (_, amt)| acc + *amt);
        let tidb = game_id_to_bytes32(tid);
        let deadline = U256::from(unix_now().saturating_add(3600));
        let escrow = self.contract();
        let digest = escrow
            .digestTournamentRoot(tidb, root, total, deadline)
            .call()
            .await?;
        let sig = self.oracle.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        let r = B256::from(sig.r());
        let s = B256::from(sig.s());
        escrow
            .settleTournamentRoot(tidb, root, total, deadline, v, r, s)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%tid, %root, "settlement(onchain): tournament root committed");
        Ok(root)
    }

    async fn is_tournament_settled(&self, tid: Uuid) -> bool {
        let tidb = game_id_to_bytes32(tid);
        match self.contract().tournaments(tidb).call().await {
            Ok(t) => t.settled,
            Err(_) => false,
        }
    }

    async fn sign_result(&self, commitment: &str) -> Option<String> {
        let sig = self.oracle.sign_message(commitment.as_bytes()).await.ok()?;
        Some(format!("0x{}", alloy::hex::encode(sig.as_bytes())))
    }

    fn signer_address(&self) -> Option<String> {
        Some(self.oracle.address().to_string())
    }

    fn escrow_address(&self) -> Option<String> {
        Some(self.escrow.to_string())
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::node_bindings::Anvil;

    #[tokio::test]
    async fn recovers_personal_sign() -> anyhow::Result<()> {
        use alloy::signers::Signer;
        let signer: PrivateKeySigner =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d".parse()?;
        let msg = "chess.example wants you to sign in\nNonce: abc123";
        let sig = signer.sign_message(msg.as_bytes()).await?;
        let sig_hex = alloy::hex::encode_prefixed(sig.as_bytes());
        let recovered = recover_personal_sign(msg, &sig_hex).expect("recover");
        assert_eq!(recovered, signer.address());
        // a tampered message recovers a different address
        assert_ne!(recover_personal_sign("different", &sig_hex), Some(signer.address()));
        Ok(())
    }

    #[tokio::test]
    async fn opens_and_settles_onchain() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();

        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let white: PrivateKeySigner = anvil.keys()[2].clone().into();
        let black: PrivateKeySigner = anvil.keys()[3].clone().into();

        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());

        // Deploy a mock USDC and the escrow (1% rake, fee sink = deployer).
        let usdc = MockUSDC::deploy(&dep).await?;
        let escrow = ChessEscrow::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            100u16,
            3600u64,
        )
        .await?;
        let escrow_addr = *escrow.address();

        // Fund and deposit for both players.
        let bankroll = U256::from(10_000_000u64); // 10 USDC
        let stake = U256::from(1_000_000u64); // 1 USDC
        for who in [&white, &black] {
            let p = ProviderBuilder::new()
                .wallet(EthereumWallet::from((*who).clone()))
                .connect_http(url.clone());
            MockUSDC::new(*usdc.address(), &p)
                .mint(who.address(), bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
            MockUSDC::new(*usdc.address(), &p)
                .approve(escrow_addr, bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
            ChessEscrow::new(escrow_addr, &p)
                .deposit(bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
        }

        // Oracle settles a White win through the real sink.
        let sink = OnchainSettlement::new(url.clone(), escrow_addr, oracle.clone());
        let game_id = Uuid::new_v4();
        sink.open_escrow(game_id, white.address(), black.address(), stake)
            .await?;
        sink.report_result(game_id, Some(white.address())).await?;

        // Winner gained stake minus 1% rake; loser lost the stake.
        let read = ChessEscrow::new(escrow_addr, &dep);
        let w = read.bankroll(white.address()).call().await?;
        let b = read.bankroll(black.address()).call().await?;
        assert_eq!(w, U256::from(10_990_000u64), "winner bankroll");
        assert_eq!(b, U256::from(9_000_000u64), "loser bankroll");
        Ok(())
    }

    #[tokio::test]
    async fn opens_enters_settles_tournament() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();
        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let players: Vec<PrivateKeySigner> =
            (2..5).map(|i| anvil.keys()[i].clone().into()).collect();

        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());
        let usdc = MockUSDC::deploy(&dep).await?;
        // 0% rake so the test arithmetic is exact.
        let escrow = ChessEscrow::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            0u16,
            3600u64,
        )
        .await?;
        let escrow_addr = *escrow.address();

        let bankroll = U256::from(10_000_000u64);
        let buy_in = U256::from(1_000_000u64);
        for who in &players {
            let p = ProviderBuilder::new()
                .wallet(EthereumWallet::from(who.clone()))
                .connect_http(url.clone());
            MockUSDC::new(*usdc.address(), &p)
                .mint(who.address(), bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
            MockUSDC::new(*usdc.address(), &p)
                .approve(escrow_addr, bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
            ChessEscrow::new(escrow_addr, &p)
                .deposit(bankroll)
                .send()
                .await?
                .get_receipt()
                .await?;
        }

        let sink = OnchainSettlement::new(url.clone(), escrow_addr, oracle.clone());
        let tid = Uuid::new_v4();
        sink.open_tournament(tid, buy_in).await?;
        for who in &players {
            sink.enter_tournament(tid, who.address()).await?;
        }
        // pool = 3 buy-ins; pay 2 / 1 / 0 (no rake)
        let addrs: Vec<Address> = players.iter().map(|s| s.address()).collect();
        let payouts = vec![
            U256::from(2_000_000u64),
            U256::from(1_000_000u64),
            U256::from(0u64),
        ];
        sink.settle_tournament(tid, addrs.clone(), payouts).await?;

        let read = ChessEscrow::new(escrow_addr, &dep);
        assert_eq!(read.bankroll(addrs[0]).call().await?, U256::from(11_000_000u64));
        assert_eq!(read.bankroll(addrs[1]).call().await?, U256::from(10_000_000u64));
        assert_eq!(read.bankroll(addrs[2]).call().await?, U256::from(9_000_000u64));
        Ok(())
    }

    #[tokio::test]
    async fn signs_and_recovers_result_commitment() {
        // EIP-191 sign a result hash, then recover the signer — exactly what the
        // browser does with viem's recoverMessageAddress to show "verified ✓".
        let signer: PrivateKeySigner =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
                .parse()
                .unwrap();
        let commitment = "9b74c9897bac770ffc029102a200c5de"; // a result_hash
        let sig = signer.sign_message(commitment.as_bytes()).await.unwrap();
        let hex = format!("0x{}", alloy::hex::encode(sig.as_bytes()));
        let recovered = recover_personal_sign(commitment, &hex).expect("recover");
        assert_eq!(recovered, signer.address());
    }

    #[test]
    fn merkle_root_and_proof_self_consistent() {
        // Rebuilding the root from a leaf + its proof must reproduce the root.
        let leaves: Vec<B256> = (0u64..5)
            .map(|i| keccak256(i.to_be_bytes()))
            .collect();
        let root = merkle_root(&leaves);
        for i in 0..leaves.len() {
            let proof = merkle_proof(&leaves, i);
            let mut h = leaves[i];
            for p in proof {
                h = hash_pair(h, p);
            }
            assert_eq!(h, root, "leaf {i} proof");
        }
    }

    #[tokio::test]
    async fn settles_tournament_via_merkle_root() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();
        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let players: Vec<PrivateKeySigner> =
            (2..5).map(|i| anvil.keys()[i].clone().into()).collect();

        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());
        let usdc = MockUSDC::deploy(&dep).await?;
        let escrow =
            ChessEscrow::deploy(&dep, *usdc.address(), oracle.address(), deployer.address(), 0u16, 3600u64)
                .await?;
        let escrow_addr = *escrow.address();

        let bankroll = U256::from(10_000_000u64);
        let buy_in = U256::from(1_000_000u64);
        for who in &players {
            let p = ProviderBuilder::new()
                .wallet(EthereumWallet::from(who.clone()))
                .connect_http(url.clone());
            MockUSDC::new(*usdc.address(), &p).mint(who.address(), bankroll).send().await?.get_receipt().await?;
            MockUSDC::new(*usdc.address(), &p).approve(escrow_addr, bankroll).send().await?.get_receipt().await?;
            ChessEscrow::new(escrow_addr, &p).deposit(bankroll).send().await?.get_receipt().await?;
        }

        let sink = OnchainSettlement::new(url.clone(), escrow_addr, oracle.clone());
        let tid = Uuid::new_v4();
        sink.open_tournament(tid, buy_in).await?;
        for who in &players {
            sink.enter_tournament(tid, who.address()).await?;
        }

        // Pool = 3 buy-ins. Tree pays p1=2, p2=1, p3=0 (p3 omitted).
        let leaves = vec![
            (players[0].address(), U256::from(2_000_000u64)),
            (players[1].address(), U256::from(1_000_000u64)),
        ];
        sink.settle_tournament_root(tid, leaves.clone()).await?;

        // Each winner claims with a Rust-built proof verified by the Solidity tree.
        let leaf_hashes: Vec<B256> =
            leaves.iter().map(|(a, amt)| tournament_leaf(*a, *amt)).collect();
        let read = ChessEscrow::new(escrow_addr, &dep);
        for (i, (acct, amt)) in leaves.iter().enumerate() {
            let proof = merkle_proof(&leaf_hashes, i);
            read.claimTournament(game_id_to_bytes32(tid), *acct, *amt, proof)
                .send()
                .await?
                .get_receipt()
                .await?;
        }

        assert_eq!(read.bankroll(players[0].address()).call().await?, U256::from(11_000_000u64));
        assert_eq!(read.bankroll(players[1].address()).call().await?, U256::from(10_000_000u64));
        assert_eq!(read.bankroll(players[2].address()).call().await?, U256::from(9_000_000u64));
        Ok(())
    }
}
