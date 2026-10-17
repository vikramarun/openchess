//! Settlement seam: takes the authoritative, server-produced game result and
//! settles it on the `ChessEscrow` contract on Base.
//!
//! The game server is the oracle: on a finished game it signs an EIP-712
//! `GameResult` and submits `settleGame`, which moves the locked stake from the
//! loser's bankroll to the winner's (minus rake). Funds live in the contract,
//! never in a platform wallet.

// The `sol!` macro generates contract bindings whose functions mirror the
// Solidity signatures — arg counts aren't ours to shrink.
#![allow(clippy::too_many_arguments)]

use alloy::network::EthereumWallet;
use alloy::primitives::{keccak256, B256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::Signer;
use alloy::sol;
use alloy::sol_types::SolValue;
use async_trait::async_trait;
use uuid::Uuid;

// Bindings generated from the Foundry build artifacts (ABI + bytecode), so we
// can both call and (in tests) deploy the contracts. The artifacts are VENDORED
// under `abi/` (committed) rather than read from `contracts/out/` — that dir is
// gitignored `forge build` output and isn't present in the Docker build context
// or on a fresh clone. Regenerate after a contract change with:
//   (cd contracts && forge build) && \
//   cp contracts/out/ChessEscrow.sol/ChessEscrow.json crates/ledger/abi/ && \
//   cp contracts/out/ChessEscrow.t.sol/MockUSDC.json  crates/ledger/abi/
sol!(
    #[sol(rpc)]
    ChessEscrow,
    "abi/ChessEscrow.json"
);

sol!(
    #[sol(rpc)]
    MockUSDC,
    "abi/MockUSDC.json"
);

// Re-exported so downstream crates (the server) don't depend on alloy directly.
pub use alloy::primitives::{Address, U256};
pub use alloy::signers::local::PrivateKeySigner;
use std::sync::Arc;

/// Build a settlement sink from the environment. If `RPC_URL`, `ESCROW_ADDR`,
/// and `ORACLE_KEY` are all set it returns an onchain sink; otherwise it falls
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
                    tracing::info!(%escrow, "settlement: onchain sink configured");
                    Arc::new(OnchainSettlement::new(url, escrow, oracle))
                }
                _ => {
                    tracing::warn!(
                        "settlement: bad RPC_URL/ESCROW_ADDR/ORACLE_KEY, using log sink"
                    );
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

/// EIP-191 `personal_sign` over `message` with a raw private key — the inverse
/// of [`recover_personal_sign`]. Returns the signer address and the 65-byte
/// signature as 0x-prefixed hex. Used by the native BYO client for SIWE.
pub fn personal_sign(key: &str, message: &str) -> anyhow::Result<(Address, String)> {
    use alloy::signers::SignerSync;
    let signer: PrivateKeySigner = key
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid private key"))?;
    let sig = signer.sign_message_sync(message.as_bytes())?;
    Ok((
        signer.address(),
        alloy::hex::encode_prefixed(sig.as_bytes()),
    ))
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
    async fn report_result(&self, game_id: Uuid, winner: Option<Address>) -> anyhow::Result<()>;

    /// Whether this sink actually settles onchain. The server refuses wagered
    /// games when this is false (fail-closed — never take money it can't settle).
    fn is_onchain(&self) -> bool {
        false
    }

    /// The escrow contract's current owner (`Ownable2Step`) — the wallet
    /// allowed to administer the server (e.g. toggle maintenance). Each call
    /// reads the live onchain owner; `None` off-chain or if the view call
    /// fails. (Callers may cache it — see `AppState::admin_wallet`.)
    async fn owner(&self) -> Option<Address> {
        None
    }

    /// Whether a game is already settled onchain. Lets the settlement worker
    /// treat a crash-after-submit (or any replay revert) as success rather than
    /// a failure. Default `false` for nonchain sinks.
    async fn is_settled(&self, _game_id: Uuid) -> bool {
        false
    }

    /// A wallet's deposited escrow balance (total, including anything currently
    /// locked in a game). `None` off-chain or if the view call fails, so a
    /// caller can tell "no balance" apart from "couldn't ask" — the difference
    /// between rejecting a request and failing open on an RPC blip.
    async fn bankroll_of(&self, _who: Address) -> Option<U256> {
        None
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

    /// Begin play, which is what starts the onchain SETTLE clock. Must be
    /// called before the entry window closes; after it, entry is refused and
    /// the tournament can only ever resolve into refunds.
    async fn start_tournament(&self, tid: Uuid) -> anyhow::Result<()> {
        tracing::info!(%tid, "settlement(log): start tournament");
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
    /// leaves; winners claim individually onchain. Returns the committed root.
    async fn settle_tournament_root(
        &self,
        tid: Uuid,
        _leaves: Vec<(Address, U256)>,
    ) -> anyhow::Result<B256> {
        tracing::info!(%tid, "settlement(log): settle tournament (root)");
        Ok(B256::ZERO)
    }

    /// Whether a tournament is already settled onchain (worker idempotency).
    async fn is_tournament_settled(&self, _tid: Uuid) -> bool {
        false
    }

    /// The tournament's current onchain pool, in token base units.
    ///
    /// The authority on what may be paid out. Deriving it as `buy_in ×
    /// entrants` assumes every entry landed and that nothing else can add to
    /// the pool — the first is untrue if an `enterTournament` silently failed,
    /// and the second stops being true the moment sponsorship exists. Paying
    /// out more than the pool reverts the whole settlement; paying out less
    /// hands the difference to the fee recipient as rake.
    ///
    /// `None` off-chain, or if the view call fails.
    async fn tournament_pool(&self, _tid: Uuid) -> Option<U256> {
        None
    }

    /// `(entry_deadline, settle_deadline)` for a tournament, as unix seconds,
    /// read live from the chain. `None` off-chain, for a tournament with no
    /// pool, or when any read fails — never a guessed default.
    ///
    /// On the two-clock escrow, entry (and the right to start) close at
    /// `openedAt + entryWindow`, and settlement at `startedAt + settleTimeout`;
    /// before the start, the settle deadline reported is the one the event
    /// would get by starting NOW. On v2 there is one clock, running from
    /// creation: settlement closes at `openedAt + settleTimeout`, and that is
    /// reported as the entry deadline too, since an entry past it can only
    /// ever be refunded.
    async fn tournament_deadlines(&self, _tid: Uuid) -> Option<(u64, u64)> {
        None
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

    /// The escrow contract address (checksummed), if this sink settles onchain.
    /// Published so the web app can wire deposits/withdrawals to the right
    /// contract without a second place to configure it.
    fn escrow_address(&self) -> Option<String> {
        None
    }
}

/// Default no-chain sink: logs what it *would* settle. Used when the server is
/// not configured with onchain credentials (e.g. the local demo).
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

    async fn report_result(&self, game_id: Uuid, winner: Option<Address>) -> anyhow::Result<()> {
        tracing::info!(%game_id, ?winner, "settlement(log): report result");
        Ok(())
    }
}

/// Onchain sink backed by the `ChessEscrow` contract on an EVM chain (Base /
/// Base Sepolia / local Anvil).
pub struct OnchainSettlement {
    provider: DynProvider,
    escrow: Address,
    oracle: PrivateKeySigner,
    /// Whether the deployed escrow has the two-clock lifecycle
    /// (`startTournament` + `entryWindow`). Learned from the width of a
    /// `tournaments()` read — 9 words with it, 8 without (v2) — and set ONLY
    /// from a read that succeeded. An RPC error must never be remembered as
    /// "no transition": that would skip `startTournament` for the life of the
    /// process on a contract that requires it, leaving every event
    /// unsettleable and refundable mid-play.
    two_clock: std::sync::OnceLock<bool>,
    /// `settleTimeout()` / `entryWindow()`, read once each. Both are set at
    /// construction with no setter, so one successful read holds for the life
    /// of the deployment; a failed read is simply retried next time.
    settle_timeout: std::sync::OnceLock<u64>,
    entry_window: std::sync::OnceLock<u64>,
    /// Blocks to wait before a write is treated as real, from
    /// `SETTLE_CONFIRMATIONS`.
    ///
    /// Default 1 — inclusion, which is what `get_receipt()` has always waited
    /// for. Raising it costs latency on the path a player is watching (a staked
    /// game cannot start until `openGame` is confirmed), which is why it is a
    /// dial rather than a hardcoded increase: Base reorgs are rare and shallow,
    /// `MAX_STAKE` is small, and a reorged-out `openGame` is now DETECTED —
    /// the postcondition read fails, and settlement of a game that no longer
    /// exists errors and alerts instead of silently succeeding. An operator who
    /// wants more margin, or who raises `MAX_STAKE`, can buy it here.
    confirmations: u64,
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
        let confirmations = std::env::var("SETTLE_CONFIRMATIONS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(1);
        if confirmations > 1 {
            tracing::info!(confirmations, "settlement: waiting extra confirmations");
        }
        OnchainSettlement {
            provider,
            escrow,
            oracle,
            two_clock: std::sync::OnceLock::new(),
            settle_timeout: std::sync::OnceLock::new(),
            entry_window: std::sync::OnceLock::new(),
            confirmations,
        }
    }

    /// The escrow's `Tournament` record, decoded in whichever layout the
    /// deployed contract has. Every tournament read goes through here.
    ///
    /// A public mapping getter returns the struct's fields flat, so adding
    /// `startedAt` changed what the SAME selector returns: 8 words on v2, 9 on
    /// the two-clock contract. Decoding with the vendored ABI alone failed
    /// every read against the live v2 ("buffer overrun"), and since callers
    /// turn a failed read into `None`/`false`, it broke tournament creation,
    /// the payout's pool read and the outbox's settled check all at once —
    /// silently. The width is also the capability marker, so it is recorded.
    async fn read_tournament(&self, tidb: B256) -> anyhow::Result<TournamentRecord> {
        use alloy::sol_types::SolCall;
        let input = ChessEscrow::tournamentsCall(tidb).abi_encode();
        let req = alloy::rpc::types::TransactionRequest::default()
            .to(self.escrow)
            .input(alloy::primitives::Bytes::from(input).into());
        let out = self.provider.call(req).await?;
        let rec = decode_tournament(&out)?;
        let _ = self.two_clock.set(rec.started_at.is_some());
        Ok(rec)
    }

    /// Whether this deployment has the two-clock tournament lifecycle.
    ///
    /// The server deploys independently of the contract, so it must run
    /// against both. Read off the shape of `tournaments()` (any id answers, an
    /// unknown one with zeros), and remembered only once a read has actually
    /// succeeded — an `Err` here is an RPC failure, and the caller must fail
    /// rather than guess. A capability check, never a catch-all: on a contract
    /// that has the transition, `startTournament` failing is still fatal.
    async fn has_start_transition(&self) -> anyhow::Result<bool> {
        if let Some(known) = self.two_clock.get() {
            return Ok(*known);
        }
        let rec = self.read_tournament(B256::ZERO).await.map_err(|e| {
            anyhow::anyhow!("could not determine the escrow's tournament lifecycle: {e:#}")
        })?;
        let present = rec.started_at.is_some();
        tracing::info!(
            two_clock_lifecycle = present,
            "settlement: escrow tournament lifecycle probed"
        );
        Ok(present)
    }

    async fn settle_timeout(&self) -> anyhow::Result<u64> {
        if let Some(v) = self.settle_timeout.get() {
            return Ok(*v);
        }
        let v = self.contract().settleTimeout().call().await?;
        let _ = self.settle_timeout.set(v);
        Ok(v)
    }

    async fn entry_window(&self) -> anyhow::Result<u64> {
        if let Some(v) = self.entry_window.get() {
            return Ok(*v);
        }
        let v = self.contract().entryWindow().call().await?;
        let _ = self.entry_window.set(v);
        Ok(v)
    }

    fn contract(&self) -> ChessEscrow::ChessEscrowInstance<DynProvider> {
        ChessEscrow::new(self.escrow, self.provider.clone())
    }

    /// Wait for a submitted transaction and **fail on a revert**.
    ///
    /// Every write path goes through here, and none may call `get_receipt()`
    /// directly. `get_receipt()` resolves as `Ok` for a transaction that mined
    /// with `status = 0` — it reports "the receipt was fetched", not "the call
    /// succeeded" — so awaiting it and dropping the value silently converts a
    /// reverted transaction into `Ok(())`. Everything downstream then acts on
    /// money that never moved: an entrant who never paid a buy-in is added to
    /// the field and takes a cut of the real pool at settlement, a game whose
    /// `openGame` reverted is run and reported as staked with neither stake
    /// locked, and a reverted `settleGame` is recorded terminally settled so
    /// the winner is never paid and nothing retries.
    ///
    /// `.send()` gas-estimates first, so most reverts surface there as `Err`.
    /// The ones that reach here are the ones where state moved between
    /// estimation and inclusion — which is exactly the case an attacker can
    /// arrange by racing their own `withdraw` against an oracle transaction
    /// that spends their bankroll.
    async fn confirm(
        &self,
        pending: alloy::providers::PendingTransactionBuilder<alloy::network::Ethereum>,
        what: &str,
    ) -> anyhow::Result<()> {
        let receipt = pending
            .with_required_confirmations(self.confirmations)
            .get_receipt()
            .await?;
        if receipt.status() {
            return Ok(());
        }
        let tx = receipt.transaction_hash;
        let reason = self.revert_reason(&receipt).await;
        anyhow::bail!("{what} REVERTED onchain (tx {tx:?}): {reason}");
    }

    /// Best-effort revert reason for a failed transaction: replay the call
    /// against the state one block before it mined. Diagnostics only — the
    /// caller has already decided this is an error, and an inconclusive
    /// answer here must never turn a revert back into a success.
    async fn revert_reason(&self, receipt: &alloy::rpc::types::TransactionReceipt) -> String {
        let hash = receipt.transaction_hash;
        let Ok(Some(tx)) = self.provider.get_transaction_by_hash(hash).await else {
            return "revert reason unavailable (could not re-fetch the transaction)".into();
        };
        let Some(prev) = receipt.block_number.and_then(|b| b.checked_sub(1)) else {
            return "revert reason unavailable (no block number on the receipt)".into();
        };
        let req: alloy::rpc::types::TransactionRequest = tx.into_request();
        match self.provider.call(req).block(prev.into()).await {
            // The replay is one block early and excludes the same-block
            // transactions that preceded this one, so a clean replay is the
            // expected shape of an ordering-dependent revert, not a
            // contradiction.
            Ok(_) => "reverted on state that changed between estimation and inclusion".into(),
            Err(e) => e.to_string(),
        }
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
        let pending = escrow.openGame(gid, white, black, stake).send().await?;
        self.confirm(pending, "openGame").await?;
        // Postcondition. `confirm` proves the transaction did not revert; this
        // proves the chain now holds the state the caller is about to rely on,
        // with the seats and stake it asked for. The caller's next act is to
        // run a game it will describe to two people as backed by money, so the
        // cost of one view call is not worth arguing about — and a mismatch
        // here (a reorg between inclusion and now, a wrong-contract config)
        // would otherwise surface only at settlement, after the game is played.
        match escrow.games(gid).call().await {
            Ok(g) if g.exists && g.white == white && g.black == black && g.stake == stake => {}
            Ok(g) if g.exists => anyhow::bail!(
                "openGame landed with unexpected terms (white {:?} black {:?} stake {})",
                g.white,
                g.black,
                g.stake
            ),
            Ok(_) => anyhow::bail!("openGame reported success but no game exists onchain"),
            Err(e) => anyhow::bail!("could not verify openGame landed: {e:#}"),
        }
        tracing::info!(%game_id, %white, %black, %stake, "settlement(onchain): opened escrow");
        Ok(())
    }

    async fn report_result(&self, game_id: Uuid, winner: Option<Address>) -> anyhow::Result<()> {
        let gid = game_id_to_bytes32(game_id);
        let winner_addr = winner.unwrap_or(Address::ZERO);
        let escrow = self.contract();

        // Bound the signature's lifetime so a captured result can't be relayed
        // indefinitely.
        let deadline = U256::from(unix_now().saturating_add(3600));

        // Ask the contract for the exact EIP-712 digest, sign it with the
        // oracle key, and submit. (Signing the contract's own digest avoids
        // re-deriving the domain separator in Rust.)
        let digest = escrow
            .digestGameResult(gid, winner_addr, deadline)
            .call()
            .await?;
        let sig = self.oracle.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        let r = B256::from(sig.r());
        let s = B256::from(sig.s());

        let pending = escrow
            .settleGame(gid, winner_addr, deadline, v, r, s)
            .send()
            .await?;
        self.confirm(pending, "settleGame").await?;
        tracing::info!(%game_id, ?winner, "settlement(onchain): settled");
        Ok(())
    }

    fn is_onchain(&self) -> bool {
        true
    }

    async fn owner(&self) -> Option<Address> {
        match self.contract().owner().call().await {
            Ok(owner) => Some(owner),
            Err(e) => {
                tracing::warn!("escrow owner() call failed: {e:#}");
                None
            }
        }
    }

    async fn is_settled(&self, game_id: Uuid) -> bool {
        let gid = game_id_to_bytes32(game_id);
        match self.contract().games(gid).call().await {
            Ok(g) => g.settled,
            Err(_) => false,
        }
    }

    async fn bankroll_of(&self, who: Address) -> Option<U256> {
        match self.contract().bankroll(who).call().await {
            Ok(b) => Some(b),
            Err(e) => {
                tracing::warn!("escrow bankroll() call failed: {e:#}");
                None
            }
        }
    }

    async fn open_tournament(&self, tid: Uuid, buy_in: U256) -> anyhow::Result<()> {
        let tidb = game_id_to_bytes32(tid);
        let escrow = self.contract();
        let pending = escrow.openTournament(tidb, buy_in).send().await?;
        self.confirm(pending, "openTournament").await?;
        // Postcondition: entries are refused against a pool that doesn't exist,
        // so a lobby advertising one that never opened collects joins that can
        // only fail.
        match self.read_tournament(tidb).await {
            Ok(t) if t.exists && t.buy_in == buy_in => {}
            Ok(t) if t.exists => {
                anyhow::bail!(
                    "openTournament landed with buy-in {} not {buy_in}",
                    t.buy_in
                )
            }
            Ok(_) => anyhow::bail!("openTournament reported success but no tournament exists"),
            Err(e) => anyhow::bail!("could not verify openTournament landed: {e:#}"),
        }
        tracing::info!(%tid, %buy_in, "settlement(onchain): opened tournament");
        Ok(())
    }

    async fn enter_tournament(&self, tid: Uuid, player: Address) -> anyhow::Result<()> {
        let tidb = game_id_to_bytes32(tid);
        let escrow = self.contract();
        let pending = escrow.enterTournament(tidb, player).send().await?;
        self.confirm(pending, "enterTournament").await?;
        // Postcondition: the entry flag is the thing the caller acts on — it
        // adds this wallet to a field whose standings divide a real pool, so
        // "they paid" has to be read off the chain rather than inferred from a
        // transaction that didn't revert.
        match escrow.tournamentEntered(tidb, player).call().await {
            Ok(true) => {}
            Ok(false) => {
                anyhow::bail!("enterTournament reported success but the entry flag is not set")
            }
            Err(e) => anyhow::bail!("could not verify enterTournament landed: {e:#}"),
        }
        tracing::info!(%tid, %player, "settlement(onchain): tournament entry");
        Ok(())
    }

    async fn start_tournament(&self, tid: Uuid) -> anyhow::Result<()> {
        // An escrow predating the two-clock lifecycle has no transition to
        // make: its settle clock has been running since `openTournament`, which
        // is exactly what the caller wants to have happened. Skipping is right
        // there, and lets the server deploy ahead of the contract.
        if !self.has_start_transition().await? {
            tracing::info!(%tid, "settlement(onchain): escrow predates startTournament; skipping");
            return Ok(());
        }
        let tidb = game_id_to_bytes32(tid);
        let escrow = self.contract();
        let pending = escrow.startTournament(tidb).send().await?;
        self.confirm(pending, "startTournament").await?;
        // Postcondition: without `startedAt` the pool cannot be settled at all,
        // so the caller must not dispatch a schedule on the strength of a
        // transaction it merely believes landed.
        match self.read_tournament(tidb).await {
            Ok(t) if t.started_at.is_some_and(|at| at != 0) => {}
            Ok(_) => anyhow::bail!("startTournament reported success but startedAt is still 0"),
            Err(e) => anyhow::bail!("could not verify startTournament landed: {e:#}"),
        }
        tracing::info!(%tid, "settlement(onchain): tournament started");
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
        let pending = escrow
            .settleTournament(tidb, players, payouts, deadline, v, r, s)
            .send()
            .await?;
        self.confirm(pending, "settleTournament").await?;
        tracing::info!(%tid, "settlement(onchain): tournament settled");
        Ok(())
    }

    async fn settle_tournament_root(
        &self,
        tid: Uuid,
        leaves: Vec<(Address, U256)>,
    ) -> anyhow::Result<B256> {
        let leaf_hashes: Vec<B256> = leaves
            .iter()
            .map(|(a, amt)| tournament_leaf(*a, *amt))
            .collect();
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
        let pending = escrow
            .settleTournamentRoot(tidb, root, total, deadline, v, r, s)
            .send()
            .await?;
        self.confirm(pending, "settleTournamentRoot").await?;
        tracing::info!(%tid, %root, "settlement(onchain): tournament root committed");
        Ok(root)
    }

    async fn is_tournament_settled(&self, tid: Uuid) -> bool {
        match self.read_tournament(game_id_to_bytes32(tid)).await {
            Ok(t) => t.settled,
            Err(e) => {
                tracing::warn!(%tid, "tournament settled read failed: {e:#}");
                false
            }
        }
    }

    async fn tournament_deadlines(&self, tid: Uuid) -> Option<(u64, u64)> {
        let t = match self.read_tournament(game_id_to_bytes32(tid)).await {
            Ok(t) if t.exists => t,
            Ok(_) => return None,
            Err(e) => {
                tracing::warn!(%tid, "tournament read failed: {e:#}");
                return None;
            }
        };
        let settle_timeout = match self.settle_timeout().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("settleTimeout() read failed: {e:#}");
                return None;
            }
        };
        // Every failure above is `None`, never a default: a guessed deadline
        // is a confident wrong answer, and both callers already treat `None`
        // as "could not ask".
        match t.started_at {
            // Single clock (v2): settlement closes at `openedAt +
            // settleTimeout`, a clock that has been running since CREATION.
            // Entry has no deadline of its own there, but an entry past that
            // instant can only ever be refunded, so it is the entry deadline
            // too.
            None => {
                let closes = t.opened_at.saturating_add(settle_timeout);
                Some((closes, closes))
            }
            // Two clocks: entry (and the right to start) close at `openedAt +
            // entryWindow`; settlement at `startedAt + settleTimeout`. Before
            // the start, report the settle deadline the event WOULD get by
            // starting now — the schedule guard's question is "if I start this
            // at this moment, can it finish?".
            Some(started_at) => {
                let entry_window = match self.entry_window().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("entryWindow() read failed: {e:#}");
                        return None;
                    }
                };
                let settle_from = if started_at != 0 {
                    started_at
                } else {
                    unix_now().max(t.opened_at)
                };
                Some((
                    t.opened_at.saturating_add(entry_window),
                    settle_from.saturating_add(settle_timeout),
                ))
            }
        }
    }

    async fn tournament_pool(&self, tid: Uuid) -> Option<U256> {
        match self.read_tournament(game_id_to_bytes32(tid)).await {
            Ok(t) => Some(t.pool),
            Err(e) => {
                tracing::warn!(%tid, "tournament pool read failed: {e:#}");
                None
            }
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

/// The escrow's `Tournament` record, independent of contract version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TournamentRecord {
    pub buy_in: U256,
    pub pool: U256,
    pub opened_at: u64,
    /// `None` on a contract without the start transition (v2), whose settle
    /// clock runs from `opened_at`. `Some(0)` means not started yet.
    pub started_at: Option<u64>,
    pub settled: bool,
    pub exists: bool,
}

/// Decode a raw `tournaments(bytes32)` return in either layout:
/// v2 `(buyIn, pool, claimedAmount, entrants, openedAt, settled, payoutRoot,
/// exists)`, or the two-clock contract's, which inserts `startedAt` after
/// `openedAt`. Anything else is an error, never a guess.
fn decode_tournament(data: &[u8]) -> anyhow::Result<TournamentRecord> {
    if !data.len().is_multiple_of(32) {
        anyhow::bail!(
            "tournaments() returned {} bytes, not whole words",
            data.len()
        );
    }
    let word = |i: usize| U256::from_be_slice(&data[i * 32..(i + 1) * 32]);
    let time = |i: usize| -> anyhow::Result<u64> {
        u64::try_from(word(i))
            .map_err(|_| anyhow::anyhow!("tournaments() word {i} is not a timestamp"))
    };
    match data.len() / 32 {
        8 => Ok(TournamentRecord {
            buy_in: word(0),
            pool: word(1),
            opened_at: time(4)?,
            started_at: None,
            settled: !word(5).is_zero(),
            exists: !word(7).is_zero(),
        }),
        9 => Ok(TournamentRecord {
            buy_in: word(0),
            pool: word(1),
            opened_at: time(4)?,
            started_at: Some(time(5)?),
            settled: !word(6).is_zero(),
            exists: !word(8).is_zero(),
        }),
        n => anyhow::bail!(
            "tournaments() returned {n} words; this server knows the 8-word (v2) and 9-word layouts"
        ),
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
        assert_ne!(
            recover_personal_sign("different", &sig_hex),
            Some(signer.address())
        );
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
            1800u64, // entryWindow: must be < settleTimeout
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

    /// A transaction that MINES WITH `status = 0` must not be reported as
    /// success. This is the whole of H-01: `get_receipt()` resolves `Ok` for a
    /// reverted transaction, so the old code (which awaited it and dropped the
    /// value) turned every revert into `Ok(())`.
    ///
    /// The revert is produced the way an attacker produces it — not by
    /// hand-setting a gas limit, which would only prove `confirm` reads a
    /// field. Automine is off. The oracle's `openGame` is submitted first and
    /// gas-estimates cleanly against a state where White's bankroll covers the
    /// stake. White then submits a `withdraw` of that whole bankroll at a much
    /// higher fee, so anvil orders it FIRST in the block. `openGame` mines
    /// second, reverts `InsufficientUnlocked`, and comes back with
    /// `status = 0` on a receipt that `get_receipt()` still resolves as `Ok`.
    /// That is H-01's exploit path end to end.
    #[tokio::test]
    async fn a_reverted_transaction_is_not_success() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();
        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let white: PrivateKeySigner = anvil.keys()[2].clone().into();
        let black: PrivateKeySigner = anvil.keys()[3].clone().into();

        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());
        let usdc = MockUSDC::deploy(&dep).await?;
        let escrow = ChessEscrow::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            100u16,
            3600u64,
            1800u64, // entryWindow: must be < settleTimeout
        )
        .await?;
        let escrow_addr = *escrow.address();

        let bankroll = U256::from(10_000_000u64);
        let stake = U256::from(1_000_000u64);
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

        // Stop mining so both submissions estimate against identical state.
        let ctl = ProviderBuilder::new().connect_http(url.clone());
        ctl.raw_request::<_, serde_json::Value>("evm_setAutomine".into(), (false,))
            .await?;

        let sink = Arc::new(OnchainSettlement::new(url.clone(), escrow_addr, oracle));
        let game_id = Uuid::new_v4();
        let (w, b) = (white.address(), black.address());

        // Submitted (and estimated) while White's bankroll still covers it.
        let opening = tokio::spawn({
            let sink = sink.clone();
            async move { sink.open_escrow(game_id, w, b, stake).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        // White pulls the whole bankroll out at a fee that outbids the oracle,
        // so this is ordered ahead of the pending `openGame`.
        let wp = ProviderBuilder::new()
            .wallet(EthereumWallet::from(white.clone()))
            .connect_http(url.clone());
        // `.gas()` bypasses estimation, which anvil runs against PENDING state
        // — where the oracle's queued `openGame` has already locked the funds.
        // An attacker sets their own gas for exactly this reason; the call
        // under test keeps its real estimation.
        let _pending_withdraw = ChessEscrow::new(escrow_addr, &wp)
            .withdraw(bankroll)
            .gas(200_000)
            .max_fee_per_gas(50_000_000_000u128)
            .max_priority_fee_per_gas(50_000_000_000u128)
            .send()
            .await?;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        // One block: the withdraw lands, then `openGame` reverts inside it.
        ctl.raw_request::<_, serde_json::Value>("evm_mine".into(), ())
            .await?;
        ctl.raw_request::<_, serde_json::Value>("evm_setAutomine".into(), (true,))
            .await?;

        let err = opening
            .await?
            .expect_err("openGame REVERTED onchain and must not report success");
        let msg = err.to_string();
        assert!(
            msg.contains("REVERTED"),
            "the error must name the revert, got: {msg}"
        );
        assert!(
            msg.contains("openGame"),
            "the error must name the call, got: {msg}"
        );

        // The decisive assertion: no game exists, so every downstream caller
        // that would have trusted `Ok(())` — the room that reports itself
        // staked, the settlement that pays a winner — was right to be stopped.
        let read = ChessEscrow::new(escrow_addr, &dep);
        let g = read.games(game_id_to_bytes32(game_id)).call().await?;
        assert!(!g.exists, "no escrow was opened, and the sink must say so");
        Ok(())
    }

    // The LIVE v2 escrow (Base 0x7a536bEF…4D68), FROZEN. This artifact is
    // main's vendored ABI from before the two-clock change, and its runtime
    // bytecode is byte-identical to the deployed contract (immutables masked;
    // checked against the chain). Never re-vendor it from source: it is the
    // old contract the server has to keep working against until the redeploy.
    sol!(
        #[sol(rpc)]
        ChessEscrowV2,
        "abi/ChessEscrowV2.json"
    );

    /// The server deploys independently of the contract, so it has to run
    /// against the escrow that is ACTUALLY deployed, not just the one in
    /// `contracts/src`. This drives every tournament path against the real v2
    /// bytecode.
    ///
    /// The previous version of this test used MockUSDC as a stand-in for "an
    /// escrow without `entryWindow()`" and passed, while every `tournaments()`
    /// read against the real v2 failed to decode — the struct is one field
    /// shorter there — so tournament creation errored after the pool opened,
    /// the payout could not read its pool, and a settled pool read back as
    /// unsettled forever. A stand-in proves nothing about decoding.
    #[tokio::test]
    async fn the_server_runs_against_the_live_v2_escrow() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();
        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let p1: PrivateKeySigner = anvil.keys()[2].clone().into();
        let p2: PrivateKeySigner = anvil.keys()[3].clone().into();
        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());
        let usdc = MockUSDC::deploy(&dep).await?;
        // v2's constructor: no entryWindow.
        let v2 = ChessEscrowV2::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            0u16,
            3600u64,
        )
        .await?;
        let unit = U256::from(1_000_000u64);
        for who in [&p1, &p2] {
            let p = ProviderBuilder::new()
                .wallet(EthereumWallet::from((*who).clone()))
                .connect_http(url.clone());
            let amt = unit * U256::from(10);
            MockUSDC::new(*usdc.address(), &p)
                .mint(who.address(), amt)
                .send()
                .await?
                .get_receipt()
                .await?;
            MockUSDC::new(*usdc.address(), &p)
                .approve(*v2.address(), amt)
                .send()
                .await?
                .get_receipt()
                .await?;
            ChessEscrowV2::new(*v2.address(), &p)
                .deposit(amt)
                .send()
                .await?
                .get_receipt()
                .await?;
        }
        let sink = OnchainSettlement::new(url, *v2.address(), oracle);

        assert!(
            !sink.has_start_transition().await?,
            "v2 has no start transition"
        );

        // Games are unaffected by the struct change, but prove it.
        let gid = Uuid::new_v4();
        sink.open_escrow(gid, p1.address(), p2.address(), unit)
            .await?;
        sink.report_result(gid, None).await?;
        assert!(sink.is_settled(gid).await);

        // The tournament path, end to end.
        let tid = Uuid::new_v4();
        sink.open_tournament(tid, unit).await?; // its postcondition reads tournaments()
        sink.enter_tournament(tid, p1.address()).await?;
        sink.enter_tournament(tid, p2.address()).await?;
        assert_eq!(sink.tournament_pool(tid).await, Some(unit * U256::from(2)));

        // v2's only clock runs from CREATION, so both deadlines are
        // openedAt + settleTimeout — not "now + settleTimeout".
        let opened_at = ChessEscrowV2::new(*v2.address(), &dep)
            .tournaments(game_id_to_bytes32(tid))
            .call()
            .await?
            .openedAt;
        assert_eq!(
            sink.tournament_deadlines(tid).await,
            Some((opened_at + 3600, opened_at + 3600))
        );

        sink.start_tournament(tid).await?; // skipped on v2, and must not error
        sink.settle_tournament(
            tid,
            vec![p1.address(), p2.address()],
            vec![unit * U256::from(2), U256::ZERO],
        )
        .await?;
        assert!(
            sink.is_tournament_settled(tid).await,
            "a pool v2 settled must read back as settled, or the outbox requeues it forever"
        );
        Ok(())
    }

    /// The other half of version support: the current escrow probes as
    /// two-clock, and there `startTournament` is required, not optional.
    #[tokio::test]
    async fn the_two_clock_escrow_requires_its_start_transition() -> anyhow::Result<()> {
        let anvil = Anvil::new().try_spawn()?;
        let url = anvil.endpoint_url();
        let deployer: PrivateKeySigner = anvil.keys()[0].clone().into();
        let oracle: PrivateKeySigner = anvil.keys()[1].clone().into();
        let dep = ProviderBuilder::new()
            .wallet(EthereumWallet::from(deployer.clone()))
            .connect_http(url.clone());
        let usdc = MockUSDC::deploy(&dep).await?;
        let escrow = ChessEscrow::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            100u16,
            3600u64,
            1800u64,
        )
        .await?;
        let live = OnchainSettlement::new(url, *escrow.address(), oracle);
        assert!(live.has_start_transition().await?);
        assert!(
            live.start_tournament(Uuid::new_v4()).await.is_err(),
            "a failing startTournament on a capable contract must stay fatal"
        );
        Ok(())
    }

    /// An RPC failure must not be remembered as "this escrow has no start
    /// transition". The probe used to cache `entryWindow().call().is_ok()`, so
    /// one transport error at the first tournament start made every later
    /// start a silent no-op for the life of the process — and on the two-clock
    /// contract an unstarted event can't be settled and turns refundable at
    /// `openedAt + entryWindow`, while it is still being played.
    #[tokio::test]
    async fn an_rpc_failure_is_not_remembered_as_a_missing_transition() {
        // Nothing listens here: every call is a transport error.
        let dead: alloy::transports::http::reqwest::Url = "http://127.0.0.1:9".parse().unwrap();
        let sink = OnchainSettlement::new(dead, Address::ZERO, PrivateKeySigner::random());
        assert!(sink.has_start_transition().await.is_err());
        assert!(
            sink.two_clock.get().is_none(),
            "a failed probe must not be cached"
        );
        assert!(
            sink.start_tournament(Uuid::new_v4()).await.is_err(),
            "and the start must fail (so tourney_start rolls back), not skip"
        );
        assert_eq!(sink.tournament_deadlines(Uuid::new_v4()).await, None);
    }

    #[test]
    fn both_tournament_layouts_decode() {
        let words = |ws: &[u64]| -> Vec<u8> {
            ws.iter()
                .flat_map(|w| U256::from(*w).to_be_bytes::<32>())
                .collect()
        };
        // v2: buyIn pool claimed entrants openedAt settled payoutRoot exists
        let v2 = decode_tournament(&words(&[5, 10, 0, 2, 1_000, 1, 0, 1])).unwrap();
        assert_eq!(
            (v2.buy_in, v2.pool, v2.opened_at),
            (U256::from(5), U256::from(10), 1_000)
        );
        assert_eq!((v2.started_at, v2.settled, v2.exists), (None, true, true));
        // two-clock: … openedAt startedAt settled payoutRoot exists
        let v3 = decode_tournament(&words(&[5, 10, 0, 2, 1_000, 1_500, 0, 0, 1])).unwrap();
        assert_eq!(
            (v3.started_at, v3.settled, v3.exists),
            (Some(1_500), false, true)
        );
        // An unknown layout is an error, never a best guess.
        assert!(decode_tournament(&words(&[1; 7])).is_err());
        assert!(decode_tournament(&words(&[1; 10])).is_err());
        assert!(decode_tournament(&[0u8; 33]).is_err());
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
            1800u64, // entryWindow: must be < settleTimeout
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
        // Play begins: this is what starts the onchain settle clock, and
        // settlement is refused without it.
        sink.start_tournament(tid).await?;
        sink.settle_tournament(tid, addrs.clone(), payouts).await?;

        let read = ChessEscrow::new(escrow_addr, &dep);
        assert_eq!(
            read.bankroll(addrs[0]).call().await?,
            U256::from(11_000_000u64)
        );
        assert_eq!(
            read.bankroll(addrs[1]).call().await?,
            U256::from(10_000_000u64)
        );
        assert_eq!(
            read.bankroll(addrs[2]).call().await?,
            U256::from(9_000_000u64)
        );
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
        let leaves: Vec<B256> = (0u64..5).map(|i| keccak256(i.to_be_bytes())).collect();
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
        let escrow = ChessEscrow::deploy(
            &dep,
            *usdc.address(),
            oracle.address(),
            deployer.address(),
            0u16,
            3600u64,
            1800u64, // entryWindow: must be < settleTimeout
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

        // Pool = 3 buy-ins. Tree pays p1=2, p2=1, p3=0 (p3 omitted).
        let leaves = vec![
            (players[0].address(), U256::from(2_000_000u64)),
            (players[1].address(), U256::from(1_000_000u64)),
        ];
        sink.start_tournament(tid).await?;
        sink.settle_tournament_root(tid, leaves.clone()).await?;

        // Each winner claims with a Rust-built proof verified by the Solidity tree.
        let leaf_hashes: Vec<B256> = leaves
            .iter()
            .map(|(a, amt)| tournament_leaf(*a, *amt))
            .collect();
        let read = ChessEscrow::new(escrow_addr, &dep);
        for (i, (acct, amt)) in leaves.iter().enumerate() {
            let proof = merkle_proof(&leaf_hashes, i);
            read.claimTournament(game_id_to_bytes32(tid), *acct, *amt, proof)
                .send()
                .await?
                .get_receipt()
                .await?;
        }

        assert_eq!(
            read.bankroll(players[0].address()).call().await?,
            U256::from(11_000_000u64)
        );
        assert_eq!(
            read.bankroll(players[1].address()).call().await?,
            U256::from(10_000_000u64)
        );
        assert_eq!(
            read.bankroll(players[2].address()).call().await?,
            U256::from(9_000_000u64)
        );
        Ok(())
    }

    /// Live end-to-end tournament **claim + refund** against a real chain (Base
    /// Sepolia). Runs the exact production Merkle code — `merkle_root` /
    /// `merkle_proof` / `tournament_leaf` — plus the same EIP-712 root-settle the
    /// server's `OnchainSettlement` performs, so it proves a Rust-built proof
    /// verifies against the deployed Solidity `_verifyProof`, on real block timing
    /// and gas (the Anvil test above only covers a local dev chain, and nothing
    /// else exercises `claimRefund`). One provider sends every `me`-signed tx to
    /// keep nonces in step — see the note below.
    ///
    /// Opt-in and `#[ignore]`d: never runs in a normal `cargo test`. Drive it via
    /// `scripts/test-sepolia-tournament.sh`, which sets:
    ///   LEDGER_TEST_RPC  — Base Sepolia RPC URL
    ///   LEDGER_TEST_KEY  — a funded testnet private key (deployer/oracle/entrant)
    ///   LEDGER_TEST_TIMEOUT — refund window in seconds (default 30)
    /// It deploys throwaway MockUSDC + escrows, so it's repeatable and the refund
    /// window is short enough to wait out.
    #[tokio::test]
    #[ignore = "live testnet run; use scripts/test-sepolia-tournament.sh"]
    async fn tournament_claim_and_refund_live() -> anyhow::Result<()> {
        let (rpc, key) = match (
            std::env::var("LEDGER_TEST_RPC"),
            std::env::var("LEDGER_TEST_KEY"),
        ) {
            (Ok(r), Ok(k)) => (r, k),
            _ => {
                eprintln!(
                    "skipping tournament_claim_and_refund_live: set LEDGER_TEST_RPC + LEDGER_TEST_KEY"
                );
                return Ok(());
            }
        };
        let refund_timeout: u64 = std::env::var("LEDGER_TEST_TIMEOUT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);

        let url = rpc.parse::<alloy::transports::http::reqwest::Url>()?;
        let signer: PrivateKeySigner = key.parse()?; // deployer + oracle + the funded entrant
        let me = signer.address();
        let provider = ProviderBuilder::new()
            .wallet(EthereumWallet::from(signer.clone()))
            .connect_http(url.clone());
        // A fee recipient distinct from the entrant (entering as the fee sink reverts).
        let fee_recipient = Address::from([0xEE; 20]);
        let explorer = "https://sepolia.basescan.org/tx";
        eprintln!("live tournament test: rpc={rpc} signer={me} refund_timeout={refund_timeout}s");

        let usdc = MockUSDC::deploy(&provider).await?;
        // Long window for the claim flow (settle never races the timeout); short
        // window for the refund flow (so we can actually wait past it).
        let escrow_pay = ChessEscrow::deploy(
            &provider,
            *usdc.address(),
            me,
            fee_recipient,
            0u16,
            3600u64,
            1800u64,
        )
        .await?;
        let escrow_ref = ChessEscrow::deploy(
            &provider,
            *usdc.address(),
            me,
            fee_recipient,
            0u16,
            refund_timeout,
            // Entry must close strictly before settlement; this deployment
            // exists to have its refund window expire, so keep entry open for
            // essentially all of it.
            refund_timeout.saturating_sub(1),
        )
        .await?;
        eprintln!(
            "deployed: usdc={} escrow_pay={} escrow_ref={}",
            usdc.address(),
            escrow_pay.address(),
            escrow_ref.address()
        );

        // mint + approve + deposit `amt` into `me`'s bankroll on `escrow`.
        let fund = |escrow: Address, amt: U256| {
            let provider = &provider;
            let usdc_addr = *usdc.address();
            async move {
                MockUSDC::new(usdc_addr, provider)
                    .mint(me, amt)
                    .send()
                    .await?
                    .get_receipt()
                    .await?;
                MockUSDC::new(usdc_addr, provider)
                    .approve(escrow, amt)
                    .send()
                    .await?
                    .get_receipt()
                    .await?;
                ChessEscrow::new(escrow, provider)
                    .deposit(amt)
                    .send()
                    .await?
                    .get_receipt()
                    .await?;
                anyhow::Ok(())
            }
        };

        // Everything `me` signs goes through this ONE provider so nonces stay in
        // step (the escrow's oracle is `me`, so `signer` also signs the EIP-712
        // root). This mirrors OnchainSettlement — itself covered by the Anvil test
        // above — while keeping a single sender to avoid cross-provider nonce
        // races; the Merkle tree is the real production code either way.

        // ---- payout claim flow (root-settled, "large" field) ----
        // One large entry funds the pool; the payout tree is decoupled from the
        // entrant set (the contract never ties leaves to entrants), so a single
        // key can stand in for a full field. buy_in covers a 17-leaf tree.
        let buy_in = U256::from(17_000_000u64); // 17 USDC (6dp)
        let leaf_amt = U256::from(1_000_000u64); // 1 USDC per winner leaf
        fund(*escrow_pay.address(), buy_in).await?;
        let pay = ChessEscrow::new(*escrow_pay.address(), &provider);
        let tid = Uuid::new_v4();
        let gid = game_id_to_bytes32(tid);
        pay.openTournament(gid, buy_in)
            .send()
            .await?
            .get_receipt()
            .await?;
        pay.enterTournament(gid, me)
            .send()
            .await?
            .get_receipt()
            .await?; // pool = 17 USDC
                     // Begin play — settlement is keyed on `startedAt` and is refused
                     // without it.
        pay.startTournament(gid).send().await?.get_receipt().await?;

        // 17 leaves: index 0 is our test winner, the rest synthetic. Total == pool.
        let winner = Address::from([0x11; 20]);
        let mut leaves = vec![(winner, leaf_amt)];
        for i in 0u8..16 {
            leaves.push((Address::from([0x40 + i; 20]), leaf_amt));
        }
        let leaf_hashes: Vec<B256> = leaves
            .iter()
            .map(|(a, amt)| tournament_leaf(*a, *amt))
            .collect();
        let root = merkle_root(&leaf_hashes);
        let total = leaves.iter().fold(U256::ZERO, |acc, (_, amt)| acc + *amt);
        let deadline = U256::from(unix_now().saturating_add(3600));
        let digest = pay
            .digestTournamentRoot(gid, root, total, deadline)
            .call()
            .await?;
        let sig = signer.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        pay.settleTournamentRoot(
            gid,
            root,
            total,
            deadline,
            v,
            B256::from(sig.r()),
            B256::from(sig.s()),
        )
        .send()
        .await?
        .get_receipt()
        .await?;
        eprintln!("root committed: root={root} tid_bytes32={gid} (== web tidToBytes32)");

        let proof = merkle_proof(&leaf_hashes, 0);
        let before = pay.bankroll(winner).call().await?;
        let rcpt = pay
            .claimTournament(gid, winner, leaf_amt, proof.clone())
            .send()
            .await?
            .get_receipt()
            .await?;
        let after = pay.bankroll(winner).call().await?;
        assert_eq!(
            after - before,
            leaf_amt,
            "payout credited to winner bankroll"
        );
        eprintln!(
            "claim OK: winner bankroll += 1 USDC  tx={}/{}",
            explorer, rcpt.transaction_hash
        );

        // A second claim must revert (AlreadyClaimed). Assert via a static call
        // (eth_call) — an actual send that reverts would leave the sender's cached
        // nonce with a phantom gap and stall the next transaction.
        let dbl = pay
            .claimTournament(gid, winner, leaf_amt, proof)
            .call()
            .await;
        assert!(dbl.is_err(), "double-claim must revert (AlreadyClaimed)");
        eprintln!("double-claim rejected ✓");

        // ---- refund flow (never settled past the timeout) ----
        fund(*escrow_ref.address(), buy_in).await?;
        let re = ChessEscrow::new(*escrow_ref.address(), &provider);
        let tid2 = Uuid::new_v4();
        let gid2 = game_id_to_bytes32(tid2);
        re.openTournament(gid2, buy_in)
            .send()
            .await?
            .get_receipt()
            .await?;
        re.enterTournament(gid2, me)
            .send()
            .await?
            .get_receipt()
            .await?; // bankroll[me] -= buy_in
        let before_ref = re.bankroll(me).call().await?;

        // Wait out the settle window (opened ~now; over-wait to clear the boundary).
        let wait = refund_timeout + 15;
        eprintln!("waiting {wait}s for the refund window to open...");
        std::thread::sleep(std::time::Duration::from_secs(wait));
        let rcpt2 = re.claimRefund(gid2, me).send().await?.get_receipt().await?;
        let after_ref = re.bankroll(me).call().await?;
        assert_eq!(after_ref - before_ref, buy_in, "refund restored the buy-in");
        eprintln!(
            "refund OK: entrant bankroll += buy-in  tx={}/{}",
            explorer, rcpt2.transaction_hash
        );
        eprintln!("LIVE TOURNAMENT CLAIM + REFUND: PASS");
        Ok(())
    }
}
