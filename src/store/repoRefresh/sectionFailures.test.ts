import { beforeEach, describe, expect, it } from "vitest";
import { useNotifications } from "@/store/notifications";
import {
  planSectionAvailability,
  reportSectionFailure,
  resolveSectionRead,
  sectionErrorMessage,
  settleRead,
} from "./sectionFailures";

const titles = () => useNotifications.getState().toasts.map((t) => t.title);

beforeEach(() => {
  useNotifications.setState({ toasts: [] });
});

describe("settleRead / resolveSectionRead", () => {
  it("keeps the previous value on rejection and takes the fresh one on success", async () => {
    const rejected = await settleRead(Promise.reject(new Error("boom")));
    expect(resolveSectionRead(rejected, ["kept"])).toEqual({ value: ["kept"], failure: "boom" });

    const fulfilled = await settleRead(Promise.resolve(["fresh"]));
    expect(resolveSectionRead(fulfilled, ["kept"])).toEqual({ value: ["fresh"], failure: null });
  });

  it("derives a message from structured errors, Errors, and plain values", () => {
    expect(sectionErrorMessage({ kind: "internal", message: "structured" })).toBe("structured");
    expect(sectionErrorMessage(new Error("thrown"))).toBe("thrown");
    expect(sectionErrorMessage("plain string")).toBe("plain string");
    expect(sectionErrorMessage({ message: "" })).toBe("Unknown error");
  });
});

describe("planSectionAvailability", () => {
  it("flags a failing section and announces it once", () => {
    const first = planSectionAvailability({}, { stashes: "boom" });
    expect(first.patch).toEqual({ unavailableSections: { stashes: "boom" } });
    first.notify();
    expect(titles()).toEqual(["Couldn't read stashes"]);
    expect(useNotifications.getState().toasts[0]).toMatchObject({ kind: "warning", body: "boom" });

    // The same failure again on a later refresh: nothing to patch, no new toast.
    const again = planSectionAvailability({ stashes: "boom" }, { stashes: "boom" });
    expect(again.patch).toEqual({});
    again.notify();
    expect(titles()).toEqual(["Couldn't read stashes"]);
  });

  it("updates the message of an already-flagged section without a second toast", () => {
    planSectionAvailability({}, { worktrees: "first" }).notify();
    const next = planSectionAvailability({ worktrees: "first" }, { worktrees: "second" });
    expect(next.patch).toEqual({ unavailableSections: { worktrees: "second" } });
    next.notify();
    expect(titles()).toEqual(["Couldn't read worktrees"]);
  });

  it("clears the flag and dismisses the toast on a successful read", () => {
    planSectionAvailability({}, { forge: "boom" }).notify();
    expect(titles()).toEqual(["Couldn't read the hosting provider"]);

    const recovered = planSectionAvailability({ forge: "boom", remotes: "x" }, { forge: null });
    expect(recovered.patch).toEqual({ unavailableSections: { remotes: "x" } });
    recovered.notify();
    expect(titles()).toEqual([]);
  });

  it("leaves sections it was not told about untouched and returns an empty patch when healthy", () => {
    const healthy = planSectionAvailability({ operation: "stale" }, { stashes: null, worktrees: null });
    expect(healthy.patch).toEqual({});
    healthy.notify();
    expect(titles()).toEqual([]);
  });

  it("reportSectionFailure sets the flag and notifies in one step", () => {
    const sets: unknown[] = [];
    reportSectionFailure((patch) => sets.push(patch), {}, "worktrees", new Error("probe failed"));
    expect(sets).toEqual([{ unavailableSections: { worktrees: "probe failed" } }]);
    expect(titles()).toEqual(["Couldn't read worktrees"]);
  });
});
