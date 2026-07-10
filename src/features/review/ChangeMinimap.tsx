import type { Tone } from "./diffTones";

// Condensed change overview pinned to the right edge of the scroll area, so the
// changed regions of a long file are visible at a glance. Positions are
// fractions of the rendered row count, matching the scroll height.
export function ChangeMinimap({ tones }: { tones: Tone[] }) {
  const total = tones.length;
  if (!total) return null;
  const bands: { start: number; len: number; tone: "add" | "del" }[] = [];
  for (let i = 0; i < total; i++) {
    const t = tones[i];
    if (t !== "add" && t !== "del") continue;
    const last = bands[bands.length - 1];
    if (last && last.tone === t && last.start + last.len === i) last.len++;
    else bands.push({ start: i, len: 1, tone: t });
  }
  if (!bands.length) return null;
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-full w-2.5 border-l border-black/5 dark:border-white/5 bg-black/[0.03] dark:bg-white/[0.04]">
      {bands.map((band, i) => (
        <div
          key={i}
          className="absolute inset-x-[1px] rounded-[1px]"
          style={{
            top: `${(band.start / total) * 100}%`,
            height: `${Math.max((band.len / total) * 100, 0.5)}%`,
            background: band.tone === "add" ? "#2e9e62" : "#f43f5e",
            opacity: 0.45,
          }}
        />
      ))}
    </div>
  );
}
