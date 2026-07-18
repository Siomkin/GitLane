// PTY pane controller races and the failure-surfacing write path (GL-176),
// driven headlessly through injected fakes: spawn/dispose identity, event
// routing, and the guarantee that input never looks accepted when the shell
// received nothing.
import { describe, expect, it, vi } from "vitest";

import { PaneController, type PaneView, type PtyIo } from "./paneController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeView() {
  const lines: string[] = [];
  const written: Uint8Array[] = [];
  const cursorEvents: string[] = [];
  let dataCb: ((data: string) => void) | null = null;
  let disposed = false;
  let removed = false;
  let fits = 0;
  const view: PaneView = {
    term: {
      write: (data) => written.push(data as Uint8Array),
      writeln: (text) => lines.push(text),
      focus: () => {},
      dispose: () => {
        disposed = true;
      },
      onData: (cb) => {
        dataCb = cb;
        return {
          dispose: () => {
            dataCb = null;
          },
        };
      },
      cols: 80,
      rows: 24,
    },
    el: {
      remove: () => {
        removed = true;
      },
      style: { display: "" },
    },
    fit: () => {
      fits++;
    },
    applyTheme: () => {},
    paste: () => {},
    bracketedPaste: () => false,
    clear: () => {},
    streamCursor: {
      onOutput: (data: Uint8Array) => cursorEvents.push(`output:${data.length}`),
      noteUserInput: () => cursorEvents.push("input"),
      dispose: () => cursorEvents.push("dispose"),
    },
  };
  return {
    view,
    lines,
    written,
    cursorEvents,
    type: (data: string) => dataCb?.(data),
    get disposed() {
      return disposed;
    },
    get removed() {
      return removed;
    },
    get fits() {
      return fits;
    },
  };
}

function setup(io: Partial<PtyIo> = {}) {
  const views: ReturnType<typeof fakeView>[] = [];
  const killed: number[] = [];
  const resized: Array<[number, number, number]> = [];
  const fullIo: PtyIo = {
    spawn: io.spawn ?? (async () => ({ sessionId: 1 })),
    write: io.write ?? (async () => {}),
    kill:
      io.kill ??
      (async (sessionId) => {
        killed.push(sessionId);
      }),
    resize:
      io.resize ??
      (async (sessionId, cols, rows) => {
        resized.push([sessionId, cols, rows]);
      }),
  };
  const onAliveChange = vi.fn();
  // Capture refit's deferred work instead of relying on requestAnimationFrame,
  // so tests interleave disposal between schedule and run.
  const scheduled: Array<() => void> = [];
  const controller = new PaneController(
    fullIo,
    () => {
      const v = fakeView();
      views.push(v);
      return v.view;
    },
    onAliveChange,
    (cb) => scheduled.push(cb),
  );
  const runScheduled = () => {
    const batch = scheduled.splice(0);
    for (const cb of batch) cb();
  };
  return { controller, views, killed, resized, onAliveChange, scheduled, runScheduled };
}

describe("PaneController — spawn/dispose identity", () => {
  it("adopts the session and routes data/exit for the right pane", async () => {
    const { controller, views, onAliveChange } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();

    expect(controller.get("tab1")?.sessionId).toBe(1);
    expect(controller.get("tab1")?.alive).toBe(true);
    expect(onAliveChange).toHaveBeenCalledTimes(1);

    controller.routeData(1, [104, 105]);
    expect(views[0].written).toHaveLength(1);

    controller.routeExit(1);
    expect(controller.get("tab1")?.alive).toBe(false);
    expect(controller.get("tab1")?.sessionId).toBeNull();
    expect(views[0].lines.some((l) => l.includes("[shell exited]"))).toBe(true);
    expect(onAliveChange).toHaveBeenCalledTimes(2);
  });

  it("replays data emitted before the spawn response identifies its session", async () => {
    const spawn = deferred<{ sessionId: number }>();
    const { controller, views } = setup({ spawn: () => spawn.promise });
    controller.create("tab1", "/repo");
    controller.routeData(7, [104, 105]);

    spawn.resolve({ sessionId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    expect(views[0].written).toHaveLength(1);
    expect([...views[0].written[0]]).toEqual([104, 105]);
    expect(controller.get("tab1")?.alive).toBe(true);
  });

  it("replays an early exit without reviving the fast-exiting shell", async () => {
    const spawn = deferred<{ sessionId: number }>();
    const { controller, views, onAliveChange } = setup({ spawn: () => spawn.promise });
    controller.create("tab1", "/repo");
    controller.routeData(7, [98, 121, 101]);
    controller.routeExit(7);

    spawn.resolve({ sessionId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    expect(views[0].written).toHaveLength(1);
    expect(controller.get("tab1")?.sessionId).toBeNull();
    expect(controller.get("tab1")?.alive).toBe(false);
    expect(views[0].lines.some((line) => line.includes("[shell exited]"))).toBe(true);
    expect(onAliveChange).toHaveBeenCalledTimes(1);
  });

  it("bounds output buffered before session adoption", async () => {
    const spawn = deferred<{ sessionId: number }>();
    const { controller, views } = setup({ spawn: () => spawn.promise });
    controller.create("tab1", "/repo");
    controller.routeData(7, new Uint8Array(70 * 1024));

    spawn.resolve({ sessionId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    expect(views[0].written[0]).toHaveLength(64 * 1024);
  });

  it("drops unadopted events when the last pending spawn settles", async () => {
    const first = deferred<{ sessionId: number }>();
    const second = deferred<{ sessionId: number }>();
    let call = 0;
    const { controller, views } = setup({
      spawn: () => (call++ === 0 ? first.promise : second.promise),
    });
    controller.create("tab1", "/repo");
    controller.routeData(99, [115, 116, 97, 108, 101]);

    first.resolve({ sessionId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    controller.create("tab2", "/repo");
    second.resolve({ sessionId: 99 });
    await Promise.resolve();
    await Promise.resolve();

    expect(views[1].written).toHaveLength(0);
    expect(controller.get("tab2")?.alive).toBe(true);
  });

  it("kills a session whose spawn resolves after the pane was disposed", async () => {
    const spawn = deferred<{ sessionId: number }>();
    const { controller, killed } = setup({ spawn: () => spawn.promise });
    controller.create("tab1", "/repo");
    controller.dispose("tab1");

    spawn.resolve({ sessionId: 7 });
    await Promise.resolve();
    await Promise.resolve();

    // The orphaned session is killed, never adopted into a gone pane.
    expect(killed).toContain(7);
    expect(controller.get("tab1")).toBeUndefined();
    expect(controller.bySession.size).toBe(0);
  });

  it("kills a session adopted-race pane replaced under the same tabId", async () => {
    const first = deferred<{ sessionId: number }>();
    let call = 0;
    const { controller, killed } = setup({
      spawn: () => (call++ === 0 ? first.promise : Promise.resolve({ sessionId: 2 })),
    });
    controller.create("tab1", "/repo");
    controller.dispose("tab1");
    controller.create("tab1", "/repo"); // remount under the same tabId
    await Promise.resolve();
    expect(controller.get("tab1")?.sessionId).toBe(2);

    first.resolve({ sessionId: 9 });
    await Promise.resolve();
    await Promise.resolve();

    // The stale spawn must not steal the remounted pane.
    expect(killed).toContain(9);
    expect(controller.get("tab1")?.sessionId).toBe(2);
  });
});

describe("PaneController — the write path never fails silently (GL-176)", () => {
  it("surfaces a rejected write in the terminal and coalesces repeats", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("pty gone"))
      .mockRejectedValueOnce(new Error("pty gone"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("pty gone again"));
    const { controller, views } = setup({ write });
    controller.create("tab1", "/repo");
    await Promise.resolve();

    // First failure prints the notice; the immediate repeat (keystroke burst)
    // does not print a second line.
    await expect(controller.write("tab1", new Uint8Array([97]))).resolves.toBe(false);
    await expect(controller.write("tab1", new Uint8Array([98]))).resolves.toBe(false);
    const notices = () => views[0].lines.filter((l) => l.includes("input not delivered"));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("pty gone");

    // A successful write re-arms the notice for the next failure.
    await expect(controller.write("tab1", new Uint8Array([99]))).resolves.toBe(true);
    await expect(controller.write("tab1", new Uint8Array([100]))).resolves.toBe(false);
    expect(notices()).toHaveLength(2);
  });

  it("reports a dead pane instead of pretending to accept input", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const { controller, views } = setup({ write });
    controller.create("tab1", "/repo");
    await Promise.resolve();
    controller.routeExit(1);

    await expect(controller.write("tab1", new Uint8Array([97]))).resolves.toBe(false);
    await expect(controller.write("tab1", new Uint8Array([98]))).resolves.toBe(false);

    expect(write).not.toHaveBeenCalled();
    const notices = views[0].lines.filter((l) => l.includes("shell not running"));
    expect(notices).toHaveLength(1); // coalesced
  });

  it("routes raw keystrokes through the surfaced write path", async () => {
    const write = vi.fn().mockRejectedValue(new Error("io error"));
    const { controller, views } = setup({ write });
    controller.create("tab1", "/repo");
    await Promise.resolve();

    views[0].type("x");
    await Promise.resolve();
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
    expect(views[0].lines.some((l) => l.includes("input not delivered"))).toBe(true);
  });

  it("returns false for an unknown tab without touching io", async () => {
    const write = vi.fn();
    const { controller } = setup({ write });
    await expect(controller.write("nope", new Uint8Array([97]))).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("PaneController — disposal", () => {
  it("dispose kills the session, disposes the terminal, and removes the element", async () => {
    const { controller, views, killed } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();

    controller.dispose("tab1");

    expect(killed).toContain(1);
    expect(views[0].disposed).toBe(true);
    expect(views[0].removed).toBe(true);
    expect(controller.panes.size).toBe(0);
    expect(controller.bySession.size).toBe(0);
  });

  it("disposeAll tears down every pane", async () => {
    const { controller, killed } = setup({
      spawn: (() => {
        let n = 0;
        return async () => ({ sessionId: ++n });
      })(),
    });
    controller.create("tab1", "/a");
    controller.create("tab2", "/b");
    await Promise.resolve();

    controller.disposeAll();
    expect(controller.panes.size).toBe(0);
    expect(killed.sort()).toEqual([1, 2]);
  });
});

describe("PaneController — multi-pane event routing (GL-177)", () => {
  it("routes data and exit to the owning pane, leaving siblings untouched", async () => {
    const { controller, views } = setup({
      spawn: (() => {
        let n = 0;
        return async () => ({ sessionId: ++n });
      })(),
    });
    controller.create("tab1", "/a");
    controller.create("tab2", "/b");
    await Promise.resolve();

    controller.routeData(2, [104, 105]);
    expect(views[0].written).toHaveLength(0);
    expect(views[1].written).toHaveLength(1);

    controller.routeExit(1);
    expect(controller.get("tab1")?.alive).toBe(false);
    expect(controller.get("tab2")?.alive).toBe(true);
    expect(views[0].lines.some((l) => l.includes("[shell exited]"))).toBe(true);
    expect(views[1].lines.some((l) => l.includes("[shell exited]"))).toBe(false);
  });

  it("drops events for a session no pane owns (after dispose)", async () => {
    const { controller, views } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();
    controller.dispose("tab1");

    controller.routeData(1, [104]);
    controller.routeExit(1);
    expect(views[0].written).toHaveLength(0);
  });
});

describe("PaneController — stream-cursor guard wiring", () => {
  it("feeds PTY output and user keystrokes to the view's guard, and disposes it", async () => {
    const { controller, views } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();

    controller.routeData(1, [104, 105]); // after the terminal write, so the
    views[0].type("x"); //                  guard's hide lands after the chunk
    controller.dispose("tab1");

    expect(views[0].cursorEvents).toEqual(["output:2", "input", "dispose"]);
  });
});

describe("PaneController — refit (GL-177)", () => {
  it("fits the pane and resizes the PTY once the scheduled frame runs", async () => {
    const { controller, views, resized, runScheduled } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();

    controller.refit("tab1");
    expect(views[0].fits).toBe(0); // deferred until layout settles

    runScheduled();
    expect(views[0].fits).toBe(1);
    expect(resized).toEqual([[1, 80, 24]]);
  });

  it("does nothing when the pane was disposed before the frame ran", async () => {
    const { controller, views, resized, runScheduled } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();

    controller.refit("tab1");
    controller.dispose("tab1");
    runScheduled();

    // Never fit or resize a disposed pane's terminal.
    expect(views[0].fits).toBe(0);
    expect(resized).toHaveLength(0);
  });

  it("fits but skips the PTY resize when the shell is not running", async () => {
    const { controller, views, resized, runScheduled } = setup();
    controller.create("tab1", "/repo");
    await Promise.resolve();
    controller.routeExit(1);

    controller.refit("tab1");
    runScheduled();

    expect(views[0].fits).toBe(1);
    expect(resized).toHaveLength(0);
  });

  it("is a no-op for an unknown tab", () => {
    const { controller, scheduled } = setup();
    controller.refit("nope");
    expect(scheduled).toHaveLength(0);
  });
});

describe("PaneController — notice kinds and dispose races (GL-176 review)", () => {
  it("prints a fresh notice when the failure mode changes (failed → exited)", async () => {
    const write = vi.fn().mockRejectedValue(new Error("pty gone"));
    const { controller, views } = setup({ write });
    controller.create("tab1", "/repo");
    await Promise.resolve();

    await controller.write("tab1", new Uint8Array([97])); // delivery failure
    controller.routeExit(1); // then the shell exits
    await controller.write("tab1", new Uint8Array([98])); // keystroke after exit

    // The dead-shell notice must not be swallowed by the earlier failure notice.
    expect(views[0].lines.some((l) => l.includes("input not delivered"))).toBe(true);
    expect(views[0].lines.some((l) => l.includes("shell not running"))).toBe(true);
  });

  it("reports 'still starting' during the spawn window, then delivers", async () => {
    const spawn = deferred<{ sessionId: number }>();
    const write = vi.fn().mockResolvedValue(undefined);
    const { controller, views } = setup({ spawn: () => spawn.promise, write });
    controller.create("tab1", "/repo");

    await expect(controller.write("tab1", new Uint8Array([97]))).resolves.toBe(false);
    await expect(controller.write("tab1", new Uint8Array([98]))).resolves.toBe(false);
    expect(views[0].lines.filter((l) => l.includes("still starting"))).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();

    spawn.resolve({ sessionId: 1 });
    await Promise.resolve();
    await expect(controller.write("tab1", new Uint8Array([99]))).resolves.toBe(true);
  });

  it("surfaces a spawn failure and reports later input against a dead shell", async () => {
    const { controller, views } = setup({ spawn: () => Promise.reject(new Error("no shell")) });
    controller.create("tab1", "/repo");
    await Promise.resolve();
    await Promise.resolve();

    expect(views[0].lines.some((l) => l.includes("Failed to start terminal"))).toBe(true);

    await expect(controller.write("tab1", new Uint8Array([97]))).resolves.toBe(false);
    expect(views[0].lines.some((l) => l.includes("shell not running"))).toBe(true);
  });

  it("never writes feedback into a disposed terminal", async () => {
    const write = deferred<void>();
    const { controller, views } = setup({ write: () => write.promise });
    controller.create("tab1", "/repo");
    await Promise.resolve();

    const pending = controller.write("tab1", new Uint8Array([97]));
    controller.dispose("tab1");
    const linesAtDispose = views[0].lines.length;

    write.reject(new Error("late failure"));
    await expect(pending).resolves.toBe(false);

    expect(views[0].lines).toHaveLength(linesAtDispose); // nothing written after dispose
  });
});
