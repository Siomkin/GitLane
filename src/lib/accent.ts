// Accent palette — the single brand colour the redesign threads through every
// accent surface (HEAD badge, primary buttons, active tabs, selected rows). The
// canonical six (green/blue/purple/teal/orange/pink) come straight from the
// design source of truth (GitLane.dc.html); indigo/cyan/red extend the range.
//
// Mirrors the design's `apply()`: `--accent` is the picked hex and `--accent-soft`
// is that colour at low alpha (a touch stronger in dark mode so the wash reads).

import type { CSSProperties } from "react";

export type AccentColor =
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "red"
  | "orange";

export interface AccentDef {
  id: AccentColor;
  label: string;
  hex: string;
}

// Display order = a loose spectrum (green → cool → magenta → warm). The first
// six are the design's canonical values; the rest are GitLane additions.
export const ACCENTS: AccentDef[] = [
  { id: "green", label: "Green", hex: "#2e9e62" },
  { id: "teal", label: "Teal", hex: "#0e9b8a" },
  { id: "cyan", label: "Cyan", hex: "#16a6c9" },
  { id: "blue", label: "Blue", hex: "#3b7ff5" },
  { id: "indigo", label: "Indigo", hex: "#5b6ef0" },
  { id: "purple", label: "Purple", hex: "#7a5af0" },
  { id: "pink", label: "Pink", hex: "#db4d8a" },
  { id: "red", label: "Red", hex: "#db4d4d" },
  { id: "orange", label: "Orange", hex: "#e07b39" },
];

const BY_ID: Record<AccentColor, AccentDef> = Object.fromEntries(
  ACCENTS.map((a) => [a.id, a]),
) as Record<AccentColor, AccentDef>;

/** Resolve an accent id to its hex, falling back to green for unknown values. */
export function accentHex(accent: AccentColor): string {
  return (BY_ID[accent] ?? BY_ID.green).hex;
}

/**
 * Inline `--accent` / `--accent-soft` custom properties for the `.gp-root`
 * element. Set on the root so they override the stylesheet defaults and cascade
 * to every `var(--accent)` consumer. The soft wash uses a slightly higher alpha
 * in dark mode (0.2 vs 0.13), matching the design.
 */
export function accentVars(accent: AccentColor, isDark: boolean): CSSProperties {
  const hex = accentHex(accent);
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const alpha = isDark ? 0.2 : 0.13;
  return {
    "--accent": hex,
    "--accent-soft": `rgba(${r}, ${g}, ${b}, ${alpha})`,
  } as CSSProperties;
}
