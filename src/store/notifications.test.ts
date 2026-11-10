import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotifications, MAX_VISIBLE, type NotifyInput } from "./notifications";
import { useUi } from "./ui";

beforeEach(() => {
  vi.useFakeTimers();
  // dismissAll() also clears the module-level timer map, so no armed handle or
  // stale entry leaks from a prior test.
  useNotifications.getState().resumeTimers("window");
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

  const actions = [{ label: "Stash", onClick: () => {} }];
  const windows: [NotifyInput["kind"], NotifyInput["actions"], number][] = [
    ["success", undefined, 5000],
    ["neutral", undefined, 5000],
    ["warning", undefined, 8000],
    ["success", actions, 10_000],
    ["warning", actions, 10_000],
    ["error", undefined, 12_000],
    ["error", actions, 12_000],
  ];

  it.each(windows)("closes %s (actions: %j) after its window", (kind, acts, ms) => {
    useNotifications.getState().notify({ kind, actions: acts, title: "t" });
    expect(useNotifications.getState().toasts[0].duration).toBe(ms);
    vi.advanceTimersByTime(ms - 1);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("keeps an in-flight progress toast past every window", () => {
    useNotifications.getState().notify({ kind: "progress", title: "Pushing…" });
    expect(useNotifications.getState().toasts[0].duration).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);
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
    useNotifications.getState().pauseTimers("pointer");

    // Time passes while hovered — nothing dismisses.
    vi.advanceTimersByTime(10_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);

    useNotifications.getState().resumeTimers("pointer");
    vi.advanceTimersByTime(2999);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("arms a toast whose finite duration was set while paused, once resumed", () => {
    useNotifications.getState().pauseTimers("pointer");
    useNotifications.getState().notify({ title: "hi" }); // 5000ms, created frozen
    // Paused: no live handle, so it never dismisses no matter how much time passes.
    vi.advanceTimersByTime(30_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    // Resume starts the full countdown.
    useNotifications.getState().resumeTimers("pointer");
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
    useNotifications.getState().pauseTimers("pointer");
    useNotifications.getState().update(id, {
      kind: "success",
      title: "Pushed",
      progress: undefined,
      duration: 5000,
    });
    // Frozen while paused — no dismissal even past the full window.
    vi.advanceTimersByTime(10_000);
    expect(useNotifications.getState().toasts).toHaveLength(1);
    useNotifications.getState().resumeTimers("pointer");
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
    expect(useNotifications.getState().leaving).toHaveLength(0);
  });

  it("holds a dismissed toast in `leaving` only for its exit", () => {
    const { notify, dismiss } = useNotifications.getState();
    notify({ title: "a" });
    const b = notify({ title: "b" });
    dismiss(b);
    expect(titles()).toEqual(["a"]);
    expect(useNotifications.getState().leaving.map((l) => [l.toast.title, l.index])).toEqual([["b", 1]]);
    vi.advanceTimersByTime(319);
    expect(useNotifications.getState().leaving).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useNotifications.getState().leaving).toHaveLength(0);
  });

  it("does not let a pause outlive the last toast", () => {
    const { notify, dismiss, pauseTimers } = useNotifications.getState();
    const only = notify({ title: "only" });
    pauseTimers("pointer");
    dismiss(only);
    expect(useNotifications.getState().paused).toBe(false);

    notify({ title: "later" });
    vi.advanceTimersByTime(5000);
    expect(titles()).toEqual([]);
  });

  it("resumes only once every hold has ended", () => {
    const { notify, pauseTimers, resumeTimers } = useNotifications.getState();
    notify({ title: "t" });
    pauseTimers("pointer");
    pauseTimers("focus");
    resumeTimers("pointer");
    vi.advanceTimersByTime(30_000);
    expect(titles()).toEqual(["t"]);
    resumeTimers("focus");
    vi.advanceTimersByTime(5000);
    expect(titles()).toEqual([]);
  });

  it("keeps a background-window hold when the last toast closes", () => {
    const { notify, dismiss, pauseTimers, resumeTimers } = useNotifications.getState();
    // A failed push in the background: the progress card goes, then the error arrives.
    const progress = notify({ kind: "progress", title: "Pushing…" });
    pauseTimers("window");
    dismiss(progress);
    expect(useNotifications.getState().paused).toBe(true);

    notify({ kind: "error", title: "Push rejected" });
    vi.advanceTimersByTime(60_000);
    expect(titles()).toEqual(["Push rejected"]);

    resumeTimers("window");
    vi.advanceTimersByTime(12_000);
    expect(titles()).toEqual([]);
  });

  it("keeps the pause while other toasts remain", () => {
    const { notify, dismiss, pauseTimers } = useNotifications.getState();
    const a = notify({ title: "a" });
    notify({ title: "b" });
    pauseTimers("pointer");
    dismiss(a);
    expect(useNotifications.getState().paused).toBe(true);
  });
});

describe("legacy useUi.showToast forwarder", () => {
  it("maps ok → success and error → raw error with the error window", () => {
    useUi.getState().showToast("Saved");
    let t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.kind).toBe("success");
    expect(t.title).toBe("Saved");
    expect(t.duration).toBe(5000);

    useUi.getState().showToast("boom", "error");
    t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.kind).toBe("error");
    expect(t.raw).toBe(true);
    expect(t.duration).toBe(12_000);
  });

  it("attaches Fix authentication… to auth-shaped error toasts, deep-linking Accounts", () => {
    useUi.setState({ settingsOpen: false, accountsConnectIntent: null });
    useUi
      .getState()
      .showToast(
        {
          kind: "auth",
          code: "credentialsMissing",
          message:
            "fatal: could not read Password for 'https://x-bitbucket-api-token-auth@bitbucket.org': terminal prompts disabled",
        },
        "error",
      );
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions?.[0]?.label).toBe("Fix authentication…");

    t.actions![0].onClick();
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("accounts");
    expect(useUi.getState().accountsConnectIntent).toBe("bitbucket");
    expect(useUi.getState().accountsConnectReason).toBe("authFailure");
  });

  it("points a repository over SSH at its server: the login command and its terminal, never Accounts", async () => {
    const { useRepo } = await import("./repo");
    const before = useRepo.getState().summary;
    useRepo.setState({ summary: { ...before!, path: "ssh://devbox/srv/app" } as never });
    useUi.setState({ settingsOpen: false, terminalView: "hidden" });
    try {
      useUi.getState().showToast(
        {
          kind: "auth",
          code: "credentialsMissing",
          message: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        },
        "error",
      );
      const t = useNotifications.getState().toasts.slice(-1)[0];
      expect(t.title).toContain("`gh auth login --hostname github.com`");
      expect(t.actions?.map((a) => a.label)).toEqual(["Open terminal", "How to set this up"]);
      t.actions![0].onClick();
      expect(useUi.getState().terminalView).toBe("open");
      expect(useUi.getState().settingsOpen).toBe(false);
    } finally {
      useRepo.setState({ summary: before });
    }
  });

  it("offers the server's terminal for an untrusted SSH host key over SSH", async () => {
    const { useRepo } = await import("./repo");
    const before = useRepo.getState().summary;
    useRepo.setState({ summary: { ...before!, path: "ssh://devbox/srv/app" } as never });
    try {
      useUi.getState().showToast(
        { kind: "network", code: "sshHostKey", message: "Host key verification failed." },
        "error",
      );
      const t = useNotifications.getState().toasts.slice(-1)[0];
      expect(t.title).toContain("Git on devbox doesn't trust the remote's SSH host key");
      expect(t.actions?.map((a) => a.label)).toEqual(["Open terminal", "How to set this up"]);
    } finally {
      useRepo.setState({ summary: before });
    }
  });

  it("opens Accounts with the permission reason for a forbidden refusal", () => {
    useUi.setState({ settingsOpen: false, accountsConnectIntent: null, accountsConnectReason: null });
    useUi.getState().showToast(
      {
        kind: "auth",
        code: "forbidden",
        message:
          "remote: Permission to Siomkin/GitLane.git denied to Siomkin.\nfatal: unable to access 'https://github.com/Siomkin/GitLane.git/': The requested URL returned error: 403",
      },
      "error",
    );
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions?.[0]?.label).toBe("Fix authentication…");
    t.actions![0].onClick();
    expect(useUi.getState().accountsConnectIntent).toBe("github");
    expect(useUi.getState().accountsConnectReason).toBe("permission");
  });

  it("offers Fix authentication… for a rejected credential", () => {
    useUi.setState({ settingsOpen: false, accountsConnectIntent: null, accountsConnectReason: null });
    useUi.getState().showToast(
      {
        kind: "auth",
        code: "credentialsRejected",
        message: "fatal: Authentication failed for 'https://github.com/Siomkin/GitLane/'",
      },
      "error",
    );
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions?.[0]?.label).toBe("Fix authentication…");
    t.actions![0].onClick();
    expect(useUi.getState().accountsConnectReason).toBe("authFailure");
  });

  it("keeps non-auth error toasts action-free", () => {
    useUi.getState().showToast("error: failed to push some refs (non-fast-forward)", "error");
    const t = useNotifications.getState().toasts.slice(-1)[0];
    expect(t.actions).toBeUndefined();
  });
});
