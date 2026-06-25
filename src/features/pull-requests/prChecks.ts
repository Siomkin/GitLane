import type { PrCheck } from "@/lib/api";

export interface PrCheckCounts {
  failed: number;
  pending: number;
  skipped: number;
  passed: number;
}

export type PrCheckTone = "pass" | "fail" | "pending" | "skipped" | "none";

export interface PrCheckSummary {
  tone: PrCheckTone;
  label: string;
}

export const countChecks = (checks: PrCheck[]): PrCheckCounts => ({
  failed: checks.filter((c) => c.state === "fail").length,
  pending: checks.filter((c) => c.state === "pending").length,
  skipped: checks.filter((c) => c.state === "skipped").length,
  passed: checks.filter((c) => c.state === "pass").length,
});

export const checkSummary = (counts: PrCheckCounts): PrCheckSummary => {
  if (counts.failed > 0) {
    return {
      tone: "fail",
      label: `${counts.failed} ${counts.failed === 1 ? "check" : "checks"} failing`,
    };
  }
  if (counts.pending > 0) {
    return {
      tone: "pending",
      label: `${counts.pending} ${counts.pending === 1 ? "check" : "checks"} running`,
    };
  }
  if (counts.skipped > 0) {
    return {
      tone: "skipped",
      label: `${counts.skipped} ${counts.skipped === 1 ? "check" : "checks"} skipped`,
    };
  }
  // No checks at all (empty rollup: no configured CI, or commits predating it) is
  // neutral, not passing — don't imply CI ran and succeeded.
  if (counts.passed === 0) {
    return { tone: "none", label: "No checks" };
  }
  return { tone: "pass", label: "All checks have passed" };
};

export const checkProgressLabel = (counts: PrCheckCounts): string => {
  const total = counts.failed + counts.pending + counts.skipped + counts.passed;
  if (total === 0) return "0";
  const finished = counts.failed + counts.skipped + counts.passed;
  return `${finished}/${total}`;
};

export const CHECK_STATUS_LABEL: Record<PrCheck["state"], string> = {
  pass: "passed",
  fail: "failed",
  pending: "pending",
  skipped: "skipped",
};
