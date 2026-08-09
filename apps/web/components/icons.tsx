import type { ReactNode } from "react";

/** The app's only icon set.
 *
 *  Inline SVG rather than a package: five glyphs do not earn a dependency, and
 *  these have to take `currentColor` so a tab can go muted → accent on the
 *  active route. That rules out the two things already in this codebase —
 *  unicode chess glyphs render IN THE FONT, so they inherit Noto Sans's design
 *  and vary by platform where coverage is missing; and the emoji used by
 *  `.mode-card` and Leaderboard are color glyphs that cannot go monochrome,
 *  which is the whole visual grammar of a tab bar.
 *
 *  24px grid, 1.75 stroke, no fills — a filled glyph at 22px on a dark panel
 *  closes up. `aria-hidden` throughout: every use pairs the glyph with a
 *  visible text label, so announcing it again is noise. */
type IconProps = { className?: string; size?: number };

function Icon({ children, className, size = 22 }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Play. A board, deliberately not the brand rook: the mark is bicolour by
 *  identity (see lib/brand.ts), and a monochrome copy of it here would be a
 *  second version of the logo, free to drift from the one `pnpm test:brand`
 *  pins. */
export function IconBoard(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </Icon>
  );
}

/** Lobby — two seats facing each other across a game. */
export function IconSwords(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 4h3.5l9 9-3.5 3.5-9-9V4Z" />
      <path d="M20 4h-3.5l-4 4M13.5 16.5 17 20l3-3-3.5-3.5" />
    </Icon>
  );
}

export function IconTrophy(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M16 5.5h2.2a2.3 2.3 0 0 1 0 4.6H16M8 5.5H5.8a2.3 2.3 0 0 0 0 4.6H8" />
      <path d="M12 13v4M8.5 20h7" />
    </Icon>
  );
}

/** Test Engine — a chip, since what that page tests is the thing doing the
 *  thinking. */
export function IconChip(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />
    </Icon>
  );
}

export function IconUser(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </Icon>
  );
}
