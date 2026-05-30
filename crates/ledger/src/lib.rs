//! Settlement seam: takes the authoritative, server-produced game result and
//! settles it on the `ChessEscrow` contract on Base.
//!
//! The game server is the oracle: on a finished game it signs an EIP-712
//! `GameResult` and submits `settleGame`, which moves the locked stake from the
//! loser's bankroll to the winner's (minus rake). Funds live in the contract,
//! never in a platform wallet.

use alloy::primitives::B256;
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::network::EthereumWallet;
use alloy::signers::Signer;
use alloy::sol;
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

        // Ask the contract for the exact EIP-712 digest, sign it with the
        // oracle key, and submit. (Signing the contract's own digest avoids
        // re-deriving the domain separator in Rust.)
        let digest = escrow.digestGameResult(gid, winner_addr).call().await?;
        let sig = self.oracle.sign_hash(&digest).await?;
        let v: u8 = if sig.v() { 28 } else { 27 };
        let r = B256::from(sig.r());
        let s = B256::from(sig.s());

        escrow
            .settleGame(gid, winner_addr, v, r, s)
            .send()
            .await?
            .get_receipt()
            .await?;
        tracing::info!(%game_id, ?winner, "settlement(onchain): settled");
        Ok(())
    }
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
}
