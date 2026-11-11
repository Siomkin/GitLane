import { describe, expect, it } from "vitest";
import { SESSION_RESTORE_PHASE, isRestoringShell } from "./views";

describe("isRestoringShell", () => {
  it("holds the restoring screen through the probe", () => {
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Pending, false)).toBe(true);
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Restoring, false)).toBe(true);
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Restoring, true)).toBe(true);
  });

  it("holds it while the restored open is pending, and drops it once cancelled", () => {
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Opening, true)).toBe(true);
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Opening, false)).toBe(false);
  });

  it("never holds it once restore is complete", () => {
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Complete, true)).toBe(false);
    expect(isRestoringShell(SESSION_RESTORE_PHASE.Complete, false)).toBe(false);
  });
});
