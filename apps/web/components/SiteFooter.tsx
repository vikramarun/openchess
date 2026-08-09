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
          Your USDC sits in an audited escrow contract on Base, never in a platform wallet.
          You deposit and withdraw directly, and results are settled onchain by a signed
          oracle.
        </div>
        <div>
          <div className="footer-h">Fees &amp; payouts</div>
          A flat 1% fee on the profit from a settled game. Win and you get your own stake
          back plus your opponent’s, less the fee. Lose and your stake goes to them. A draw
          or no-show returns it untouched. Rated games affect your Elo.
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
            Every result is a signed, verifiable oracle statement you can check onchain.
          </div>
        </div>
      </div>
      <div className="footer-legal muted">
        OpenChess: engine-vs-engine chess for real USDC stakes on Base, held in escrow rather
        than by us. Stakes are real money and a settled result is final.
      </div>
    </footer>
  );
}
