// The one relative-age rule: the same unit boundaries (a month is 30 days, a
// year 12 of them) for every "x ago" label — commit lists, file history, blame,
// PR lists — so the same age never reads differently across panes.

const UNITS = [
  { seconds: 365 * 86400, short: "y", long: "year" },
  { seconds: 30 * 86400, short: "mo", long: "month" },
  { seconds: 86400, short: "d", long: "day" },
  { seconds: 3600, short: "h", long: "hour" },
  { seconds: 60, short: "m", long: "minute" },
] as const;

/** The largest whole unit in `seconds` (≥ 60), e.g. `{ value: 2, unit: DAY }`. */
export function ageParts(seconds: number): { value: number; short: string; long: string } {
  const unit = UNITS.find((u) => seconds >= u.seconds) ?? UNITS[UNITS.length - 1];
  return { value: Math.floor(seconds / unit.seconds), short: unit.short, long: unit.long };
}

/** "x ago" from a unix-seconds timestamp: "2d ago", or with `long`
 * "2 days ago". "just now" under a minute (and for a future timestamp); ""
 * for a missing one. */
export function relativeTime(
  unixSeconds: number,
  { long = false, now = Date.now() }: { long?: boolean; now?: number } = {},
): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, now / 1000 - unixSeconds);
  if (diff < 60) return "just now";
  const { value, short, long: word } = ageParts(diff);
  return long ? `${value} ${word}${value === 1 ? "" : "s"} ago` : `${value}${short} ago`;
}
