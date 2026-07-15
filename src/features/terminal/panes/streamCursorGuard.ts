// Suppresses ConPTY's cursor-jump artifact in the integrated terminal on
// Windows. conhost's VT renderer repaints each frame in TWO write bursts
// ~15 ms apart: first `?25l <move-to-repaint-origin> ?25h`, then
// `?25l <paint> <restore-app-cursor> ?25h` (captured from a real ConPTY dump —
// see the PR). Between those bursts the cursor is deliberately SHOWN parked at
// the start of the region about to be repainted, i.e. mid-word in redrawn
// text. xterm.js renders per animation frame, so while a TUI agent animates
// its spinner (~10 fps) the cursor visibly jumps between the repaint origin
// and the real position — it reads as several fast-blinking cursors. ConPTY
// emits no synchronized-output (DEC 2026) wraps, so xterm's native support for
// that mode never engages.
//
// Mitigation: while program output is streaming and the user is not actively
// typing, keep the cursor hidden by appending DECTCEM "hide" after each output
// chunk; once output has been quiet for a beat, re-show it — but only if the
// stream's own last DECTCEM state was "visible", so a TUI that hid its cursor
// on purpose is never fought. A keystroke re-shows the cursor immediately and
// opens a grace window in which echo output never hides it, so prompt typing
// keeps its cursor. The guard only ever appends escape sequences to the local
// xterm instance — nothing is written back to the PTY, so the shell and
// ConPTY never observe it.

/** Echo arriving within this window of a keystroke never hides the cursor. */
export const INPUT_GRACE_MS = 250;
/** How long the PTY must stay quiet before the cursor is re-shown. Must sit
 * comfortably above a TUI spinner's frame gap (~95 ms observed for ConPTY
 * repaint ticks), or the cursor would strobe back mid-animation. */
export const RESHOW_QUIET_MS = 250;

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

/** Complete DECSET/DECRST private-mode sequences; DECTCEM is param 25 (the
 * params list form covers combined `CSI ? 25;… h` writers). */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g;
/** A chunk tail that could be the start of a DECSET/DECRST split across PTY
 * chunk boundaries; carried into the next scan. Bounded so a pathological
 * stream cannot grow the carry. */
const PARTIAL_CSI_TAIL = /\x1b(?:\[\??[0-9;]{0,16})?$/;

/** Injectable clock/timer seam so tests drive time explicitly. */
export interface GuardTimers {
  now(): number;
  set(cb: () => void, ms: number): number;
  clear(id: number): void;
}

const realTimers: GuardTimers = {
  now: () => Date.now(),
  set: (cb, ms) => window.setTimeout(cb, ms),
  clear: (id) => window.clearTimeout(id),
};

/** Bytes → string, 1:1 (latin1). Escape sequences are pure ASCII and UTF-8
 * continuation bytes can never contain 0x1b, so scanning is exact. */
function latin1(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
  return out;
}

export class StreamCursorGuard {
  /** The stream's own last DECTCEM state — what ConPTY/the app wants. */
  private appVisible = true;
  /** Whether WE are currently overriding the cursor to hidden. */
  private hidden = false;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private carry = "";
  private timer: number | null = null;
  private disposed = false;

  constructor(
    /** Appends escape sequences to the pane's xterm (never to the PTY). */
    private readonly writeToTerm: (seq: string) => void,
    private readonly timers: GuardTimers = realTimers,
  ) {}

  /** A user keystroke: the cursor belongs to the user now. Re-show it (if the
   * stream last wanted it visible) and open the echo grace window. */
  noteUserInput(): void {
    if (this.disposed) return;
    this.lastInputAt = this.timers.now();
    if (this.hidden) {
      this.hidden = false;
      this.cancelTimer();
      if (this.appVisible) this.writeToTerm(SHOW);
    }
  }

  /** Called after each PTY output chunk has been written to the terminal. */
  onOutput(data: Uint8Array): void {
    if (this.disposed) return;
    const lastMode = this.scan(data);
    if (this.timers.now() - this.lastInputAt <= INPUT_GRACE_MS) return;
    // Streaming, and the user isn't typing: override the cursor to hidden.
    // Re-assert after any chunk whose own trailing state re-showed it (ConPTY
    // ends every repaint burst with a show).
    if (!this.hidden || lastMode === "show") {
      this.hidden = true;
      this.writeToTerm(HIDE);
    }
    this.armQuietTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /** Track DECTCEM through the chunk (splits across chunk boundaries are
   * carried); returns the chunk's last DECTCEM direction, if any. */
  private scan(data: Uint8Array): "show" | "hide" | null {
    const text = this.carry + latin1(data);
    let last: "show" | "hide" | null = null;
    for (const match of text.matchAll(DEC_PRIVATE_MODE)) {
      if (!match[1].split(";").includes("25")) continue;
      last = match[2] === "h" ? "show" : "hide";
    }
    if (last !== null) this.appVisible = last === "show";
    this.carry = PARTIAL_CSI_TAIL.exec(text)?.[0] ?? "";
    return last;
  }

  private armQuietTimer(): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.hidden = false;
      if (this.appVisible) this.writeToTerm(SHOW);
    }, RESHOW_QUIET_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
