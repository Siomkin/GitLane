import type { ReflogEntry } from "@/lib/api";

export const reflogLabel = (entry: ReflogEntry) =>
  entry.shortSelector || entry.selector || entry.refName || entry.shortOid;

export const reflogTime = (entry: ReflogEntry) => {
  if (!entry.timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(entry.timestamp * 1000));
};

export const recoveryBranchName = (entry: ReflogEntry) => {
  const base = (entry.refName || "head").replace(/^refs\/heads\//, "").replace(/[^\w./-]+/g, "-");
  return `recovery/${base.replace(/^\/+|\/+$/g, "") || entry.shortOid}`;
};
