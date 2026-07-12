"use client";

import { shortAddress } from "@/lib/address";
import { contractUrl as explorerContractUrl } from "@/lib/escrow";
import { useOnchainConfig } from "@/lib/useOnchainConfig";

/** Trust footer for a money app: non-custodial framing, the fee, and a direct
 *  link to the escrow contract on the block explorer so anyone can verify it. */
export function SiteFooter() {
  const { config } = useOnchainConfig();
  const contractUrl =
    config?.escrow ? explorerContractUrl(config.chainId, config.escrow) : null;

  return (
    <footer className="site-footer">
      <div className="footer-cols">
        <div>
          <div className="footer-h">Non-custodial</div>
          Your USDC sits in an audited escrow contract on Base — never in a platform wallet.
          You deposit and withdraw directly; results are settled on-chain by a signed oracle.
        </div>
        <div>
          <div className="footer-h">Fees &amp; payouts</div>
          A flat 1% fee on the winnings of a settled wager. Win nets both stakes minus the fee;
          a draw or no-show returns your stake. Rated games affect your Elo.
        </div>
        <div>
          <div className="footer-h">Verify it yourself</div>
          {contractUrl ? (
            <a href={contractUrl} target="_blank" rel="noopener noreferrer">
              Escrow contract {config?.escrow ? shortAddress(config.escrow) : ""} ↗
            </a>
          ) : (
            <span className="muted">Escrow contract address loads from the server config.</span>
          )}
          <div style={{ marginTop: 4 }}>
            Every result is a signed, verifiable oracle statement you can check on-chain.
          </div>
        </div>
      </div>
      <div className="footer-legal muted">
        OpenChess — engine-vs-engine chess with non-custodial USDC wagers on Base. Play
        responsibly; wagers are real and final once settled.
      </div>
    </footer>
  );
}
