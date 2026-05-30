// Shared time controls used across all game modes. The server enforces the
// clock; engines play to it (see lib/play.ts → bestMoveWithClock).

export type TimeControl = { label: string; initial: number; inc: number };

export const TIME_CONTROLS: TimeControl[] = [
  { label: "1+0", initial: 60, inc: 0 }, // bullet
  { label: "3+0", initial: 180, inc: 0 }, // blitz
  { label: "5+0", initial: 300, inc: 0 }, // blitz
  { label: "10+0", initial: 600, inc: 0 }, // rapid
];

export const DEFAULT_TC: TimeControl = TIME_CONTROLS[1]; // 3+0

export function tcByLabel(label?: string | null): TimeControl {
  return TIME_CONTROLS.find((t) => t.label === label) ?? DEFAULT_TC;
}
