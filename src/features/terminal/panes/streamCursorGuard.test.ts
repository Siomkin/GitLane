// The Windows ConPTY cursor-artifact suppressor. Chunks below reproduce the
// captured ConPTY repaint pattern (two write bursts per animation tick: a
// `hide, move-to-repaint-origin, SHOW` burst, then the paint burst that
// restores the app cursor) — the intermediate shown-at-origin state is what
// flickers in xterm. The guard is driven headlessly through its injected
// clock; no xterm, no React.
import { describe, expect, it } from "vitest";

import {
  INPUT_GRACE_MS,
  RESHOW_QUIET_MS,
  StreamCursorGuard,
  type GuardTimers,
} from "./streamCursorGuard";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const bytes = (s: string) => new TextEncoder().encode(s);

/** Deterministic clock: `advance` fires due timers in time order. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; cb: () => void }>();
  const timers: GuardTimers = {
    now: () => now,
    set: (cb, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, cb });
      return id;
    },
    clear: (id) => {
      pending.delete(id);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      pending.delete(due[0]);
      due[1].cb();
    }
    now = target;
  };
  return { timers, advance, get pendingCount() { return pending.size; } };
}

function setup() {
  const clock = fakeClock();
  const writes: string[] = [];
  const guard = new StreamCursorGuard((seq) => writes.push(seq), clock.timers);
  return { clock, writes, guard };
}

/** One captured ConPTY animation tick: the cursor-parking burst, then the
 * repaint burst 15ms later. Both end with a DECTCEM show. */
function playTick(guard: StreamCursorGuard, advance: (ms: number) => void) {
  guard.onOutput(bytes("\x1b[?25l\x1b[H\x1b[?25h"));
  advance(15);
  guard.onOutput(bytes("\x1b[?25lWorking / step\x1b[9;5H\x1b[?25h"));
}

describe("StreamCursorGuard — spinner bursts (the ConPTY artifact)", () => {
  it("keeps the cursor hidden across animation ticks and re-shows once quiet", () => {
    const { clock, writes, guard } = setup();

    for (let tick = 0; tick < 4; tick++) {
      playTick(guard, clock.advance);
      clock.advance(80); // ConPTY tick gap — well inside the quiet window
    }
    // Every chunk ends with ConPTY's own show, so the guard must re-assert
    // hide each time and never emit a show mid-animation.
    expect(writes.every((w) => w === HIDE)).toBe(true);
    expect(writes.length).toBeGreaterThan(0);

    clock.advance(RESHOW_QUIET_MS);
    expect(writes[writes.length - 1]).toBe(SHOW);
    expect(writes.filter((w) => w === SHOW)).toHaveLength(1);
  });

  it("does not re-assert hide after a chunk that left the cursor hidden", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("\x1b[?25l\x1b[Hpaint\x1b[?25h")); // ends shown → hide
    clock.advance(15);
    guard.onOutput(bytes("\x1b[?25l\x1b[Hmore")); // ends hidden → nothing to override
    expect(writes).toEqual([HIDE]);
  });

  it("never re-shows a cursor the stream itself left hidden (TUI hid it)", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("\x1b[?25l\x1b[Hspinner frame")); // app-hidden
    clock.advance(RESHOW_QUIET_MS + 100);
    expect(writes).not.toContain(SHOW);
  });

  it("re-shows after the stream's later show even when an earlier frame hid", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("\x1b[?25lframe"));
    clock.advance(50);
    guard.onOutput(bytes("done\x1b[?25h")); // stream's final state: visible
    clock.advance(RESHOW_QUIET_MS);
    expect(writes[writes.length - 1]).toBe(SHOW);
  });

  it("keeps deferring the re-show while output continues", () => {
    const { clock, writes, guard } = setup();
    for (let i = 0; i < 10; i++) {
      guard.onOutput(bytes("\x1b[?25lx\x1b[?25h"));
      clock.advance(RESHOW_QUIET_MS - 50);
    }
    expect(writes).not.toContain(SHOW);
    clock.advance(50);
    expect(writes[writes.length - 1]).toBe(SHOW);
  });
});

describe("StreamCursorGuard — DECTCEM tracking edge cases", () => {
  it("recognizes a hide split across chunk boundaries", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("frame\x1b[?2"));
    clock.advance(10);
    guard.onOutput(bytes("5l"));
    clock.advance(RESHOW_QUIET_MS + 100);
    expect(writes).not.toContain(SHOW); // the split ?25l was seen
  });

  it("recognizes a show split across chunk boundaries", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("\x1b[?25lframe\x1b[?25"));
    clock.advance(10);
    guard.onOutput(bytes("h"));
    clock.advance(RESHOW_QUIET_MS);
    expect(writes[writes.length - 1]).toBe(SHOW);
  });

  it("honors DECTCEM inside a combined private-mode params list", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("frame\x1b[?12;25l"));
    clock.advance(RESHOW_QUIET_MS + 100);
    expect(writes).not.toContain(SHOW);
  });

  it("ignores non-DECTCEM private modes when deciding the re-show", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("frame\x1b[?2004h\x1b[?12l")); // no mode 25 anywhere
    clock.advance(RESHOW_QUIET_MS);
    expect(writes[writes.length - 1]).toBe(SHOW); // default: visible
  });
});

describe("StreamCursorGuard — typing keeps its cursor", () => {
  it("does not hide on echo output within the input grace window", () => {
    const { clock, writes, guard } = setup();
    guard.noteUserInput();
    clock.advance(30);
    guard.onOutput(bytes("a")); // shell echo
    expect(writes).toEqual([]);
  });

  it("hides again for program output after the grace window has passed", () => {
    const { clock, writes, guard } = setup();
    guard.noteUserInput();
    clock.advance(INPUT_GRACE_MS + 50);
    guard.onOutput(bytes("build output..."));
    expect(writes).toEqual([HIDE]);
  });

  it("a keystroke while suppressed re-shows the cursor immediately", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("stream\x1b[?25h"));
    expect(writes).toEqual([HIDE]);
    clock.advance(50);
    guard.noteUserInput();
    expect(writes).toEqual([HIDE, SHOW]);
    // The pending quiet re-show was cancelled — no duplicate show later.
    clock.advance(RESHOW_QUIET_MS + 100);
    expect(writes).toEqual([HIDE, SHOW]);
  });

  it("a keystroke never shows a cursor the stream wants hidden", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("tui frame\x1b[?25l"));
    clock.advance(50);
    guard.noteUserInput();
    expect(writes).not.toContain(SHOW);
  });
});

describe("StreamCursorGuard — disposal", () => {
  it("dispose cancels the pending re-show and ignores later calls", () => {
    const { clock, writes, guard } = setup();
    guard.onOutput(bytes("stream\x1b[?25h"));
    guard.dispose();
    clock.advance(RESHOW_QUIET_MS + 100);
    guard.onOutput(bytes("late"));
    guard.noteUserInput();
    expect(writes).toEqual([HIDE]);
    expect(clock.pendingCount).toBe(0);
  });
});
