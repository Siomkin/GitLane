import { describe, expect, it } from "vitest";
import type { PrCheck } from "@/lib/api";
import { checkProgressLabel, checkSummary, countChecks } from "./prChecks";

const check = (state: PrCheck["state"]): PrCheck => ({ name: state, state });

describe("prChecks", () => {
  it("does not report skipped checks as passed", () => {
    const summary = checkSummary(countChecks([check("pass"), check("skipped")]));
    expect(summary).toEqual({ tone: "skipped", label: "1 check skipped" });
  });

  it("prioritizes failures and pending checks over skipped checks", () => {
    expect(checkSummary(countChecks([check("fail"), check("skipped")])).tone).toBe("fail");
    expect(checkSummary(countChecks([check("pending"), check("skipped")])).tone).toBe("pending");
  });

  it("reports finished checks as progress over the total", () => {
    expect(
      checkProgressLabel(countChecks([check("pass"), check("skipped"), check("pending")])),
    ).toBe("2/3");
  });
});
