import type { Metadata } from "next";
import Link from "next/link";

import { BRAND_NAME, LEGAL_UPDATED, SOCIALS } from "@/lib/brand";

// A Server Component, so the metadata lives here rather than in a sibling
// layout: the "every page needs a layout.tsx for its title" rule in CLAUDE.md
// exists because every other page is `"use client"`, and these two are not.
export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "The terms you accept by using OpenChess: non-custodial stakes, how a game settles onchain, and what we do and don't promise.",
  alternates: { canonical: "/terms" },
};

const GITHUB = SOCIALS.find((s) => s.id === "github")!.url;

export default function TermsPage() {
  return (
    <div className="container legal">
      <h1>Terms of Use</h1>
      <p className="legal-meta muted">Last updated {LEGAL_UPDATED}</p>

      <p className="legal-lede">
        {BRAND_NAME} is an interface to engine-vs-engine chess. Games can be played for real
        USDC stakes, which are held by a smart contract on Base and never by us. By using the
        site you accept these terms. If you don’t, don’t use it.
      </p>

      <h2>1. What this service is</h2>
      <p>
        Chess games here are played by software. You either bring your own UCI engine or use
        the Stockfish build that runs in your browser; our server acts as the referee — it
        enforces the rules and the clock, records the moves, and declares the result.
      </p>
      <p>
        A game can be free or staked. A staked game locks both players’ USDC in the{" "}
        <code>ChessEscrow</code> contract on Base. When the game finishes, our oracle signs the
        result and the contract pays out. We are not a party to the wager, we do not take
        custody of your funds, and there is no house account playing against you.
      </p>

      <h2>2. Who may use it</h2>
      <p>
        You must be at least 18 and legally able to enter a contract. Staking money on the
        outcome of a game is regulated differently everywhere, and in some places it is
        prohibited outright. Working out whether your use of the staked features is lawful
        where you live is your responsibility, not ours. Don’t use the service if it isn’t, and
        don’t use it if you or your wallet are subject to sanctions.
      </p>

      <h2>3. Your wallet and your funds</h2>
      <p>
        The service is non-custodial. You connect a wallet you control, and you sign every
        transaction yourself. Money you deposit sits in the escrow contract under your own
        address; you withdraw it directly, without asking us. We cannot move, freeze, reverse or
        recover your funds, and neither can anyone else.
      </p>
      <p>
        That cuts both ways: if you lose your keys, send to a wrong address, or approve a
        transaction you didn’t understand, the funds are gone and we cannot help you. Signing in
        uses{" "}
        <a href="https://eips.ethereum.org/EIPS/eip-4361" target="_blank" rel="noopener noreferrer">
          Sign-In with Ethereum
        </a>
        , which is a signature proving you hold the address — it never moves funds and never
        gives us spending power.
      </p>

      <h2>4. Stakes, results and fees</h2>
      <ul>
        <li>
          Both stakes lock onchain before the first move. Win and you take your own stake back
          plus your opponent’s, less a <b>1% fee on the profit</b>. Lose and your stake goes to
          them. A draw returns both stakes untouched.
        </li>
        <li>
          A player who never turns up forfeits the game, and the stake with it. A game that both
          sides leave unplayed is called off and both stakes come back.
        </li>
        <li>
          The server is the sole authority on legality, the clock and the result. Its decision
          is <b>final</b>, and once the contract has paid out the result cannot be reversed.
          Every result is a signed statement you can verify onchain yourself.
        </li>
        <li>
          Ratings follow the money: a staked game or a paid tournament moves your ranked Elo, a
          free game moves a separate casual rating. Neither is a thing of value, and we may
          recalculate or reset ratings.
        </li>
        <li>
          Stakes are capped while the contract is unaudited. We may change the cap, the fee, or
          the available time controls at any time; changes apply to games created after them.
        </li>
      </ul>

      <h2>5. If settlement doesn’t happen</h2>
      <p>
        Settlement depends on our oracle being able to send a transaction. If it can’t — we’re
        offline, the key is unavailable, the network is congested — the contract has a timeout
        after which either player can call <code>claimTimeout</code> and take their own stake
        back, and the site surfaces that as a refund button. A tournament pool has the
        equivalent (<code>claimRefund</code>). Your recovery path does not depend on us being
        around to run it.
      </p>

      <h2>6. Risks you accept</h2>
      <ul>
        <li>
          <b>The contract is not independently audited.</b> Its source is public and verified on
          the block explorer; read it before you stake anything. A bug in it could cost you your
          funds.
        </li>
        <li>
          <b>Your engine plays your moves, and you own the outcome.</b> A crashed engine, a bad
          time-management setting, a slow connection or a closed browser tab can lose a game and
          a stake. So can a losing position.
        </li>
        <li>
          <b>Blockchains are not reversible.</b> Gas costs, failed transactions, chain reorgs,
          RPC downtime, and stablecoin risk are all yours.
        </li>
        <li>
          <b>Never stake money you cannot afford to lose.</b>
        </li>
      </ul>

      <h2>7. Playing fair</h2>
      <p>Don’t:</p>
      <ul>
        <li>
          arrange results between wallets you control or cooperate with, to farm ratings, drain
          a prize pool, or launder a payout;
        </li>
        <li>
          attack, overload or probe the service, evade rate limits, or exploit a bug instead of
          reporting it (report contract or server bugs to us before using them — see below);
        </li>
        <li>
          upload a profile photo you don’t have the rights to, or one that is unlawful or
          obscene;
        </li>
        <li>impersonate someone else, onchain or in a display name.</li>
      </ul>
      <p>
        We can refuse service, void a game, or remove content that breaks these rules. Note the
        engine name shown next to a seat is self-declared and unverified — treat it as a claim,
        not a fact.
      </p>

      <h2>8. Availability</h2>
      <p>
        The service is provided as-is, with no promise of uptime. We may take it down for
        maintenance, drain it before a deploy, or stop running it entirely. Games in progress
        can be aborted, in which case staked funds are refunded rather than paid out.
      </p>

      <h2>9. No warranty, and the limit of what we owe you</h2>
      <p>
        To the fullest extent the law allows, {BRAND_NAME} is provided without warranties of any
        kind, express or implied, including fitness for a particular purpose and
        non-infringement. We are not liable for lost profits, lost stakes, lost data, or any
        indirect or consequential damage arising from your use of the service, the smart
        contract, or any engine you connect to it. Nothing here excludes liability that cannot
        lawfully be excluded.
      </p>

      <h2>10. The software</h2>
      <p>
        The client, the server and the contract are open source under the MIT licence and are
        available on{" "}
        <a href={GITHUB} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        . The licence governs the code; these terms govern this hosted service.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update these terms. The date at the top is when they last changed, and continuing
        to use the service after that means you accept the new version.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions, bug reports and disclosure of security issues:{" "}
        <a href={`${GITHUB}/issues`} target="_blank" rel="noopener noreferrer">
          open an issue on GitHub
        </a>
        . See also our <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
