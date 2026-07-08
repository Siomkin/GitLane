import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotifications, MAX_VISIBLE } from "./notifications";
import { useUi } from "./ui";

beforeEach(() => {
  vi.useFakeTimers();
  // dismissAll() also clears the module-level timer map, so no armed handle or
  // stale entry leaks from a prior test.
  useNotifications.getState().dismissAll();
  useNotifications.setState({ paused: false });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const titles = () => useNotifications.getState().toasts.map((t) => t.title);

describe("notify defaults", () => {
  it("defaults kind to info and auto-dismisses transient toasts after 5s", () => {
    const { notify } = useNotifications.getState();
    notify({ title: "Fetch scheduled" });
    const [t] = useNotifications.getState().toasts;
    expect(t.kind).toBe("info");
    expect(t.duration).toBe(5000);

    vi.advanceTimersByTime(4999);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("persists errors, progress, and actionable toasts (no auto-dismiss timer)", () => {
    const { notify } = useNotifications.getState();
    notify({ kind: "error", title: "Push rejected" });
    notify({ kind: "progress", title: "Pushing…" });
    notify({ kind: "success", title: "Uncommitted", actions: [{ label: "Stash", onClick: () => {} }] });
    expect(useNotifications.getState().toasts.every((t) => t.duration === null)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(useNotifications.getState().toasts).toHaveLength(3);
  });

  it("honours an explicit duration override", () => {
    useNotifications.getState().notify({ kind: "error", title: "brief", duration: 1000 });
    vi.advanceTimersByTime(1000);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

describe("stacking", () => {
  it("stacks newest last and drops the oldest past the cap", () => {
    const { notify } = useNotifications.getState();
    for (let i = 0; i < MAX_VISIBLE + 2; i += 1) notify({ title: `t${i}` });
    const shown = titles();
    expect(shown).toHaveLength(MAX_VISIBLE);
    // The two oldest fell off; newest is last.
    expect(shown[0]).toBe("t2");
    expect(shown[shown.length - 1]).toBe(`t${MAX_VISIBLE + 1}`);
  });

  it("keeps an in-flight progress toast when the cap is exceeded", () => {
    const { notify } = useNotifications.getState();
    const pid = notify({ kind: "progress", title: "op" });
    for (let i = 0; i < MAX_VISIBLE; i += 1) notify({ kind: "error", title: `e${i}` });
    const shown = useNotifications.getState().toasts;
    expect(shown).toHaveLength(MAX_VISIBLE);
    expect(shown.some((t) => t.id === pid)).toBe(true); // progress survived eviction
    expect(shown.map((t) => t.title)).not.toContain("e0"); // oldest dismissible dropped
  });

  it("shows a new toast even when the stack is full of in-flight progress", () => {
    const { notify } = useNotifications.getState();
    for (let i = 0; i < MAX_VISIBLE; i += 1) notify({ kind: "progress", title: `p${i}` });
    const errId = notify({ kind: "error", title: "boom" });
    const shown = useNotifications.getState().toasts;
    expect(shown).toHaveLength(MAX_VISIBLE);
    expect(shown.some((t) => t.id === errId)).toBe(true); // the new toast is kept…
    expect(shown.map((t) => t.title)).not.toContain("p0"); // …the oldest progress goes
  });
});

describe("progress lifecycle", () => {
  it("updates progress in place, then resolves into a self-dismissing success", () => {
    const id = useNotifications.getState().notify({ kind: "progress", title: "Pushing…", progress: 0 });
    useNotifications.getState().update(id, { progress: 0.64 });
    expect(useNotifications.getState().toasts[0].progress).toBe(0.64);

    // Still persistent while in flight.
    vi.advanceTimersByTime(30_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);

    // Resolve → success with a fresh countdown.
    useNotifications.getState().update(id, { kind: "success", title: "Pushed", progress: undefined, duration: 5000 });
    expect(useNotifications.getState().toasts[0].kind).toBe("success");
    vi.advanceTimersByTime(5000);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

describe("pause / resume", () => {
  it("freezes the countdown while paused and resumes with the remaining time", () => {
    useNotifications.getState().notify({ title: "hi" }); // 5000ms
    vi.advanceTimersByTime(2000);
    useNotifications.getState().pauseTimers();

    // Time passes while hovered — nothing dismisses.
    vi.advanceTimersByTime(10_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);

    useNotifications.getState().resumeTimers();
    vi.advanceTimersByTime(2999);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("arms a toast whose finite duration was set while paused, once resumed", () => {
    useNotifications.getState().pauseTimers();
    useNotifications.getState().notify({ title: "hi" }); // 5000ms, created frozen
    // Paused: no live handle, so it never dismisses no matter how much time passes.
    vi.advanceTimersByTime(30_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    // Resume starts the full countdown.
    useNotifications.getState().resumeTimers();
    vi.advanceTimersByTime(4999);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

describe("duration changes", () => {
  it("reschedules the countdown when a live toast's duration changes", () => {
    const id = useNotifications.getState().notify({ title: "x", duration: 5000 });
    vi.advanceTimersByTime(1000);
    useNotifications.getState().update(id, { duration: 2000 });
    // The old 5s deadline is discarded; a fresh 2s window runs from the update.
    vi.advanceTimersByTime(1999);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("dismisses a progress toast resolved to success while paused, once resumed", () => {
    // The real scenario: a push/fetch/pull resolves to success while the pointer
    // is over the stack.
    const id = useNotifications.getState().notify({ kind: "progress", title: "Pushing…" });
    useNotifications.getState().pauseTimers();
    useNotifications.getState().update(id, {
      kind: "success",
      title: "Pushed",
      progress: undefined,
      duration: 5000,
    });
    // Frozen while paused — no dismissal even past the full window.
    vi.advanceTimersByTime(10_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    useNotifications.getState().resumeTimers();
    vi.advanceTimersByTime(5000);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

describe("dismissal", () => {
  it("dismisses one and clears all", () => {
    const { notify, dismiss, dismissAll } = useNotifications.getState();
    const a = notify({ kind: "error", title: "a" });
    notify({ kind: "error", title: "b" });
    dismiss(a);
    expect(titles()).toEqual(["b"]);
    dismissAll();
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

describe("legacy useUi.showToast forwarder", () => {
  it("maps ok → success and error → persistent raw error", () => {
    useUi.getState().showToast("Saved");
    let t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.kind).toBe("success");
    expect(t.title).toBe("Saved");
    expect(t.duration).toBe(5000);

    useUi.getState().showToast("boom", "error");
    t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.kind).toBe("error");
    expect(t.raw).toBe(true);
    expect(t.duration).toBeNull();

    // Legacy dismiss clears only the most recent toast, not the whole stack.
    useUi.getState().dismissToast();
    expect(useNotifications.getState().toasts.map((t) => t.title)).toEqual(["Saved"]);
  });

  it("attaches Fix authentication… to auth-shaped error toasts, deep-linking Accounts", () => {
    useUi.setState({ settingsOpen: false, accountsConnectIntent: null });
    useUi
      .getState()
      .showToast(
        "fatal: could not read Password for 'https://x-bitbucket-api-token-auth@bitbucket.org': terminal prompts disabled",
        "error",
      );
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions?.[0]?.label).toBe("Fix authentication…");

    t.actions![0].onClick();
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("accounts");
    expect(useUi.getState().accountsConnectIntent).toBe("bitbucket");
  });

  it("keeps non-auth error toasts action-free", () => {
    useUi.getState().showToast("error: failed to push some refs (non-fast-forward)", "error");
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions).toBeUndefined();
  });
});
