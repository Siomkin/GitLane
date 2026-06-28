// Pure, framework-free helpers shared by the history-inspection views
// (file history, blame, compare). No React, no store, no IPC.

import { LANE_COLORS } from "../graph/palette";

/** Compact relative time ("2 days ago") from a unix-seconds timestamp. */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  const units: [number, string][] = [
    [60, "min"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2629800, "month"],
    [31557600, "year"],
  ];
  let chosen = units[0];
  for (const u of units) {
    if (diff >= u[0]) chosen = u;
  }
  const value = Math.floor(diff / chosen[0]);
  return `${value} ${chosen[1]}${value === 1 ? "" : "s"} ago`;
}

/** Very compact relative age for the dense blame gutter ("2d", "3wk"). */
export function shortAge(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Date.now() / 1000 - unixSeconds;
  const units: [number, string][] = [
    [31557600, "y"],
    [2629800, "mo"],
    [604800, "wk"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [secs, label] of units) {
    if (diff >= secs) return `${Math.floor(diff / secs)}${label}`;
  }
  return "now";
}

/** Deterministic lane color for an oid, so blame runs read like graph lanes. */
export function oidColor(oid: string): string {
  let hash = 0;
  for (let i = 0; i < oid.length; i++) hash = (hash * 31 + oid.charCodeAt(i)) >>> 0;
  return LANE_COLORS[hash % LANE_COLORS.length]!;
}
