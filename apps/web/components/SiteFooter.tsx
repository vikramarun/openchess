"use client";

import Link from "next/link";

import { SocialLinks } from "@/components/SocialLinks";
import { shortAddress } from "@/lib/address";
import { BRAND_NAME } from "@/lib/brand";
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
          Your USDC sits in an open-source, non-custodial escrow contract on Base, never in
          a platform wallet.
          You deposit and withdraw directly, and results are settled onchain by a signed
          oracle.
        </div>
        <div>
          <div className="footer-h">Fees &amp; payouts</div>
          A flat 1% fee on the profit from a settled game. Win and you get your own stake
          back plus your opponent’s, less the fee. Lose and your stake goes to them. A draw
          or no-show returns it untouched. Staked games move your ranked Elo; free games move a
          separate casual Elo.
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
          <div className="footer-verify">
            Every result is a signed, verifiable oracle statement you can check onchain.
          </div>
        </div>
      </div>
      {/* The bottom bar. What used to be here was a paragraph of disclaimer,
          which is the wrong shape for the two things it was trying to be: the
          risk it described now has a page that can say it properly (/terms),
          and the trust framing is already the three columns above. No year in
          the copyright on purpose — the root layout is statically rendered, so
          a `getFullYear()` would freeze at build time on the server and
          disagree with the browser every January. */}
      <div className="footer-bottom">
        <div className="footer-links">
          <span className="muted">© {BRAND_NAME}</span>
          <Link href="/terms">Terms of Use</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </div>
        <SocialLinks />
      </div>
    </footer>
  );
}
