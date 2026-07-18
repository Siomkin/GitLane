// PTY pane bookkeeping for the integrated terminal (GL-176): pane creation and
// disposal, PTY event routing, and the single write path with user-visible
// failure. Framework-free — useTerminalPanes injects the real xterm/DOM/api
// adapters and keeps React reconciliation; tests inject fakes and drive the
// exact spawn/dispose/write races headlessly.

/** The xterm surface the controller drives (structural subset of Terminal). */
export interface TerminalLike {
  write(data: Uint8Array | string): void;
  writeln(text: string): void;
  focus(): void;
  dispose(): void;
  onData(cb: (data: string) => void): { dispose(): void };
  readonly cols: number;
  readonly rows: number;
}

/** One pane's view pieces, built by the injected factory. The hook's factory
 * closes over the real xterm Terminal + FitAddon + mount element; the extra
 * members carry the xterm-specific operations the hook needs back out without
 * the controller depending on xterm. */
export interface PaneView {
  term: TerminalLike;
  /** The pane's mount element; the hook toggles visibility on it. */
  el: { remove(): void; style: { display: string } };
  /** Re-fit the terminal to its container (FitAddon in production). */
  fit(): void;
  /** Re-apply the light/dark theme (reads the element's CSS vars). */
  applyTheme(): void;
  /** xterm's paste path (brackets only when the program asked for it). */
  paste(text: string): void;
  /** Whether the foreground program requested bracketed-paste mode. */
  bracketedPaste(): boolean;
  /** Clear the scrollback. */
  clear(): void;
  /** Optional ConPTY cursor-artifact suppressor (Windows panes only — see
   * streamCursorGuard.ts). The controller feeds it output and keystrokes;
   * the view factory decides whether the platform needs one. */
  streamCursor?: {
    onOutput(data: Uint8Array): void;
    noteUserInput(): void;
    dispose(): void;
  };
}

/** The PTY IPC surface the controller needs (`api.pty*` in production). */
export interface PtyIo {
  spawn(cwd: string, cols: number, rows: number): Promise<{ sessionId: number }>;
  write(sessionId: number, data: Uint8Array): Promise<void>;
  kill(sessionId: number): Promise<void>;
  resize(sessionId: number, cols: number, rows: number): Promise<void>;
}

/** One live terminal pane: a view bound to a Rust PTY session. */
export interface Pane {
  view: PaneView;
  /** The Rust PTY session id, or null before spawn resolves / after exit. */
  sessionId: number | null;
  /** The shell's working directory. */
  cwd: string;
  alive: boolean;
  onData: { dispose(): void } | null;
  /** True from create until spawn settles — input in that window gets a
   * "still starting" notice, not a dead-shell one. */
  spawning: boolean;
  /** When PTY output last arrived (0 = never). The agent-launch injection uses
   * this as a readiness signal: a TUI is accepting input once it has STOPPED
   * drawing, so the paste waits for output quiescence (GL-176 follow-up). */
  lastOutputAt: number;
  /** The KIND of write-feedback notice last printed with no success since
   * ("" = none). Coalesced per kind: a keystroke burst prints one line, but a
   * new failure mode (delivery failed → shell exited) still surfaces instead
   * of being swallowed by the previous notice (GL-176 review). */
  lastWriteNotice: "" | "starting" | "dead" | "failed";
}

interface PendingSessionEvents {
  chunks: Uint8Array[];
  bytes: number;
  exited: boolean;
}

const MAX_PENDING_SESSIONS = 32;
const MAX_PENDING_SESSION_BYTES = 64 * 1024;

export class PaneController {
  readonly panes = new Map<string, Pane>();
  readonly bySession = new Map<number, string>();
  /** Rust can emit immediately after creating a session, before Tauri resolves
   * the spawn invoke with its id. Keep that narrow adoption window bounded by
   * both session count and bytes, then replay once the owning pane is known. */
  private readonly pendingSessionEvents = new Map<number, PendingSessionEvents>();

  constructor(
    private readonly io: PtyIo,
    private readonly createView: (cwd: string) => PaneView,
    /** Nudge React when a pane's `alive` flips (panes live outside state). */
    private readonly onAliveChange: () => void,
    /** Defer refit work until layout has settled (a frame in production;
     * tests capture the callback to interleave disposal before it runs). */
    private readonly schedule: (cb: () => void) => void = (cb) =>
      requestAnimationFrame(() => cb()),
  ) {}

  get(tabId: string): Pane | undefined {
    return this.panes.get(tabId);
  }

  create(tabId: string, cwd: string): void {
    const view = this.createView(cwd);
    const pane: Pane = {
      view,
      sessionId: null,
      cwd,
      alive: false,
      onData: null,
      spawning: true,
      lastOutputAt: 0,
      lastWriteNotice: "",
    };
    this.panes.set(tabId, pane);
    pane.onData = view.term.onData((data) => {
      view.streamCursor?.noteUserInput();
      void this.write(tabId, new TextEncoder().encode(data));
    });
    view.term.writeln("\x1b[2mStarting shell in " + cwd + "…\x1b[0m");
    this.io
      .spawn(cwd, view.term.cols || 80, view.term.rows || 24)
      .then(({ sessionId }) => {
        // Guard by pane IDENTITY, not tabId presence: a fast unmount→remount
        // (or StrictMode's double-mount) can dispose this pane and create a new
        // one under the same tabId before this spawn resolves. Adopting the
        // session into the wrong (or a gone) pane would orphan a PTY and
        // cross-wire its output — so kill it instead.
        if (this.panes.get(tabId) !== pane) {
          this.pendingSessionEvents.delete(sessionId);
          this.clearPendingIfNoSpawns();
          void this.io.kill(sessionId).catch(() => {});
          return;
        }
        pane.spawning = false;
        pane.sessionId = sessionId;
        this.bySession.set(sessionId, tabId);
        const pending = this.pendingSessionEvents.get(sessionId);
        this.pendingSessionEvents.delete(sessionId);
        this.clearPendingIfNoSpawns();
        if (pending) {
          for (const chunk of pending.chunks) this.routeData(sessionId, chunk);
          if (pending.exited) {
            this.routeExit(sessionId);
            return;
          }
        }
        pane.alive = true;
        this.onAliveChange();
      })
      .catch((e) => {
        // The pane may have been disposed while the spawn was failing — never
        // write into a disposed terminal.
        if (this.panes.get(tabId) !== pane) {
          this.clearPendingIfNoSpawns();
          return;
        }
        pane.spawning = false;
        this.clearPendingIfNoSpawns();
        view.term.writeln(
          "\x1b[31mFailed to start terminal: " +
            String(e instanceof Error ? e.message : e) +
            "\x1b[0m",
        );
      });
  }

  dispose(tabId: string): void {
    const pane = this.panes.get(tabId);
    if (!pane) return;
    pane.onData?.dispose();
    pane.view.streamCursor?.dispose();
    if (pane.sessionId != null) {
      this.bySession.delete(pane.sessionId);
      void this.io.kill(pane.sessionId).catch(() => {});
    }
    pane.view.term.dispose();
    pane.view.el.remove();
    this.panes.delete(tabId);
    this.clearPendingIfNoSpawns();
  }

  disposeAll(): void {
    for (const tabId of [...this.panes.keys()]) this.dispose(tabId);
  }

  /** Fit one pane to its container and resize its PTY to match, deferred so
   * layout has settled. Guarded by pane identity: the pane may be disposed
   * (or replaced under the same tabId) before the scheduled frame fires —
   * never touch a disposed terminal. */
  refit(tabId: string): void {
    const pane = this.panes.get(tabId);
    if (!pane) return;
    this.schedule(() => {
      if (this.panes.get(tabId) !== pane) return;
      try {
        pane.view.fit();
        if (pane.sessionId != null) {
          // Resize failures are non-input noise (they race normal shell
          // exits); they don't go through the surfaced write path deliberately.
          void this.io.resize(pane.sessionId, pane.view.term.cols, pane.view.term.rows).catch(() => {});
        }
      } catch {
        /* container hidden — ignore */
      }
    });
  }

  routeData(sessionId: number, data: ArrayLike<number>): void {
    const tabId = this.bySession.get(sessionId);
    if (!tabId) {
      this.bufferPendingData(sessionId, data);
      return;
    }
    const pane = this.panes.get(tabId);
    if (!pane) return;
    pane.lastOutputAt = Date.now();
    const bytes = new Uint8Array(data);
    pane.view.term.write(bytes);
    pane.view.streamCursor?.onOutput(bytes);
  }

  routeExit(sessionId: number): void {
    const tabId = this.bySession.get(sessionId);
    if (!tabId) {
      this.bufferPendingExit(sessionId);
      return;
    }
    this.bySession.delete(sessionId);
    const pane = this.panes.get(tabId);
    if (!pane) return;
    pane.sessionId = null;
    pane.alive = false;
    pane.view.term.writeln("\r\n\x1b[2m[shell exited]\x1b[0m");
    this.onAliveChange();
  }

  private pendingEvents(sessionId: number): PendingSessionEvents | null {
    // Unknown events are meaningful only while at least one spawn is waiting
    // for adoption. Drop late events from already-retired sessions otherwise.
    if (![...this.panes.values()].some((pane) => pane.spawning)) return null;
    const existing = this.pendingSessionEvents.get(sessionId);
    if (existing) return existing;
    if (this.pendingSessionEvents.size >= MAX_PENDING_SESSIONS) {
      const oldest = this.pendingSessionEvents.keys().next().value as number | undefined;
      if (oldest !== undefined) this.pendingSessionEvents.delete(oldest);
    }
    const created: PendingSessionEvents = { chunks: [], bytes: 0, exited: false };
    this.pendingSessionEvents.set(sessionId, created);
    return created;
  }

  private clearPendingIfNoSpawns(): void {
    if (![...this.panes.values()].some((pane) => pane.spawning)) {
      this.pendingSessionEvents.clear();
    }
  }

  private bufferPendingData(sessionId: number, data: ArrayLike<number>): void {
    const pending = this.pendingEvents(sessionId);
    if (!pending || pending.exited || pending.bytes >= MAX_PENDING_SESSION_BYTES) return;
    const remaining = MAX_PENDING_SESSION_BYTES - pending.bytes;
    const chunk = Uint8Array.from(data).slice(0, remaining);
    if (chunk.length === 0) return;
    pending.chunks.push(chunk);
    pending.bytes += chunk.length;
  }

  private bufferPendingExit(sessionId: number): void {
    const pending = this.pendingEvents(sessionId);
    if (pending) pending.exited = true;
  }

  /** The one PTY write path (GL-176). Resolves true when the shell accepted
   * the bytes. A write against a dead pane, or one the backend rejects, is
   * surfaced IN the terminal — input must never look accepted while the shell
   * received nothing. Notices coalesce until a write succeeds again. */
  async write(tabId: string, data: Uint8Array): Promise<boolean> {
    const pane = this.panes.get(tabId);
    if (!pane) return false;
    if (pane.sessionId == null) {
      const kind = pane.spawning ? "starting" : "dead";
      if (pane.lastWriteNotice !== kind) {
        pane.lastWriteNotice = kind;
        pane.view.term.writeln(
          kind === "starting"
            ? "\r\n\x1b[2m[shell is still starting — input ignored]\x1b[0m"
            : "\r\n\x1b[2m[shell not running — input ignored]\x1b[0m",
        );
      }
      return false;
    }
    try {
      await this.io.write(pane.sessionId, data);
      pane.lastWriteNotice = "";
      return true;
    } catch (e) {
      // The pane may have been disposed while the write was in flight — never
      // write feedback into a disposed terminal.
      if (this.panes.get(tabId) !== pane) return false;
      // The pty-exit event owns flipping `alive`; this surfaces the lost input
      // the moment it happens (the TOCTOU window between guard and write).
      if (pane.lastWriteNotice !== "failed") {
        pane.lastWriteNotice = "failed";
        pane.view.term.writeln(
          "\r\n\x1b[31m[input not delivered: " +
            String(e instanceof Error ? e.message : e) +
            "]\x1b[0m",
        );
      }
      return false;
    }
  }
}
