import type { Metadata } from "next";
import Link from "next/link";

import { BRAND_NAME, GITHUB_URL, LEGAL_UPDATED } from "@/lib/brand";

// A Server Component, so the metadata lives here rather than in a sibling
// layout — see the note in ../terms/page.tsx.
export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What OpenChess knows about you: a wallet address and the games you played. No account to create on our servers, no tracking cookies, no analytics.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="container legal">
      <h1>Privacy Policy</h1>
      <p className="legal-meta muted">Last updated {LEGAL_UPDATED}</p>

      <p className="legal-lede">
        There is no account to create on our servers: to us you are a wallet address and a list of
        games. We store no email, no name and no password, we set no tracking cookies, and we run
        no analytics or advertising scripts of any kind. One exception is worth stating up front —
        if you sign in with email or Google rather than a browser wallet, our login provider
        creates a wallet for you and receives that email or Google identity. See{" "}
        <b>Signing in</b> below.
      </p>

      <h2>What we hold</h2>
      <ul>
        <li>
          <b>Your wallet address.</b> It is your identity on the site — it labels your games,
          your rating and your profile. It is public information on the blockchain already.
        </li>
        <li>
          <b>The games you play.</b> Moves, clock times, time control, result, the stake if
          there was one, and the engine name a seat declared. Games are public: anyone can open
          a game link or a player profile.
        </li>
        <li>
          <b>Your ratings</b> — ranked and casual — derived from those games.
        </li>
        <li>
          <b>A profile photo, if you upload one.</b> Stored as an image next to your address and
          served publicly. Your browser crops and shrinks it to a 256px square before it is
          sent.
        </li>
        <li>
          <b>Names you type</b> for a bot or a tournament entry, which are shown to other
          players.
        </li>
      </ul>

      <h2>What we don’t</h2>
      <p>
        No passwords, no phone numbers, no payment details — a stake never touches a card or a
        bank, only your own wallet. No advertising or analytics SDKs, no third-party trackers, no
        profile built across other websites, and nothing sold or shared for marketing. The one
        personal identifier that can enter the picture is an email or Google account, and only if
        you choose that way to sign in — it is handled by our login provider, not stored in our
        game database. See <b>Signing in</b>.
      </p>

      <h2>Technical data</h2>
      <p>
        Our server keeps a short-lived count of requests per IP address, in memory, to stop one
        client flooding the service. It is not written to our database and it disappears when
        the process restarts. Our hosting providers keep ordinary request logs (which include IP
        addresses) on our behalf, as any web host does.
      </p>

      <h2>What stays in your browser</h2>
      <p>
        Most of what the site remembers about you never leaves your device. Your board and piece
        theme, coordinate and animation settings, the eval-bar switch, your bot configuration
        and your sign-in session all live in this browser’s local storage, and any opening book
        you upload lives in its IndexedDB. Clearing site data resets all of it. Signing out
        deletes the session.
      </p>

      <h2>Signing in</h2>
      <p>
        We use <b>Dynamic</b> (dynamic.xyz) to handle sign-in. Connecting a browser wallet you
        already have just asks that wallet to sign a message — we receive only your address and
        the signature, no email. Choosing <b>email or Google</b> instead has Dynamic verify that
        identity and create an embedded wallet for you: in that case Dynamic receives your email
        address or Google account and holds a share of that wallet’s keys, under{" "}
        <a href="https://www.dynamic.xyz/privacy-policy" target="_blank" rel="noopener noreferrer">
          its own privacy policy
        </a>
        . Either way, what reaches our own systems is still just a wallet address and a
        signature.
      </p>

      <h2>Wallets and the blockchain</h2>
      <p>
        Connecting a wallet and signing in means talking to your wallet software and to a Base
        RPC endpoint, which can see your address and IP. Pairing a mobile wallet also goes
        through WalletConnect’s relay, which sees the connection metadata. Those are your wallet
        provider’s, that endpoint’s and WalletConnect’s systems, under their own privacy
        policies, not ours.
      </p>
      <p>
        Anything that settles onchain — a deposit, a stake, a payout — is written to a public
        blockchain permanently. We cannot edit or delete it, and neither can anyone else. Treat
        an address you use here as public.
      </p>

      <h2>Who else sees it</h2>
      <p>
        Infrastructure providers that host the site, the game server and the database process
        this data for us and for nothing else. Beyond that, we disclose data only if the law
        requires it. Everything else on this list is already public by design.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Games and ratings are the permanent public record of play and are kept for as long as
        the service runs. A profile photo is kept until you replace it. Sessions expire on their
        own. Onchain records cannot be deleted by anyone.
      </p>

      <h2>Your choices</h2>
      <p>
        You can use the site without signing in at all — watch games, browse profiles, play the
        in-browser engine — in which case we hold nothing about you. Signed in, you can replace
        your photo at any time, disconnect your wallet, and clear this browser’s storage. If you
        want the off-chain data attached to your address removed, ask us; note that we cannot
        remove anything from the blockchain, and that removing a game record would rewrite
        another player’s history too, so we may keep the game itself while unlinking what we
        can.
      </p>
      <p>
        Depending on where you live you may have rights to access, correct, export or object to
        the processing of your data. Contact us and we’ll do what we can with the little we
        hold.
      </p>

      <h2>Children</h2>
      <p>
        The service is not for anyone under 18, and we do not knowingly collect data from
        children.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update this policy; the date at the top is when it last changed. To ask anything
        about it,{" "}
        <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
          open an issue on GitHub
        </a>
        . {BRAND_NAME}’s <Link href="/terms">Terms of Use</Link> cover the rest of the
        relationship.
      </p>
    </div>
  );
}
