// Notification (toast) state — split out of `useUi` so the frequent, timer-driven
// churn of the toast stack never re-renders view chrome subscribed to the UI
// store. This is the app's notification surface: a bottom-left stack of cards
// across six statuses (info/success/warning/error/progress/neutral), each with
// an optional body, 0–2 actions, and an auto-dismiss timer that pauses on hover.
// Ports `Notifications.dc.html`.
//
// The legacy `showToast(message, tone)` API stays on `useUi` as a thin forwarder
// into this store (see store/ui.ts), so existing call sites keep working.

import { create } from "zustand";

export type NotifyKind = "info" | "success" | "warning" | "error" | "progress" | "neutral";

export interface NotifyAction {
  label: string;
  /** Invoked on click; the toast auto-dismisses afterwards. */
  onClick: () => void;
  /** "secondary" = bordered button (default), "ghost" = borderless text. */
  variant?: "secondary" | "ghost";
}

export interface Notification {
  id: number;
  kind: NotifyKind;
  /** Bold primary line. */
  title: string;
  /** Optional second line / detail. */
  body?: string;
  /** 0–2 action buttons (capped in the renderer). */
  actions?: NotifyAction[];
  /** Determinate fraction 0–1, or "indeterminate", for the progress bar. Only
   *  meaningful when `kind === "progress"`. */
  progress?: number | "indeterminate";
  /** Auto-dismiss delay in ms; null persists until dismissed / resolved. */
  duration: number | null;
  /** Render the primary line as a scrollable, selectable block — for long
   *  multi-line git/hook error output (the legacy error-toast affordance). */
  raw?: boolean;
}

/** Input to `notify` — `kind` defaults to "info", `duration` is derived when
 *  omitted (errors, progress, and actionable toasts persist; others auto-clear). */
export interface NotifyInput {
  kind?: NotifyKind;
  title: string;
  body?: string;
  actions?: NotifyAction[];
  progress?: number | "indeterminate";
  duration?: number | null;
  raw?: boolean;
}

/** Most toasts stacked at once; older ones drop off the top so a burst can't
 *  bury the window. The design shows three; four leaves a little headroom. */
export const MAX_VISIBLE = 4;

/** Default auto-dismiss window for a transient toast. */
const DEFAULT_TTL = 5000;

/** Errors, in-flight progress, and anything carrying an action wait for the
 *  user; everything else self-clears. */
function defaultDuration(input: NotifyInput): number | null {
  if (input.duration !== undefined) return input.duration;
  if (input.kind === "error" || input.kind === "progress") return null;
  if (input.actions && input.actions.length > 0) return null;
  return DEFAULT_TTL;
}

interface NotifyState {
  toasts: Notification[];
  /** True while the pointer is over the stack — freezes every countdown. */
  paused: boolean;
  /** Push a toast; returns its id so long-running ops can `update`/`dismiss` it. */
  notify: (input: NotifyInput) => number;
  /** Patch an existing toast (e.g. progress %, or resolve progress → success).
   *  Re-arms or clears the auto-dismiss timer when `duration` changes. */
  update: (id: number, patch: Partial<Omit<Notification, "id">>) => void;
  dismiss: (id: number) => void;
  dismissAll: () => void;
  pauseTimers: () => void;
  resumeTimers: () => void;
}

let seq = 0;

/** Per-toast auto-dismiss bookkeeping. `handle` is undefined while paused; the
 *  remaining time is recomputed from `startedAt` on pause so hovering never
 *  loses the countdown. Kept module-level (not in the store) — it's imperative
 *  timer plumbing, not render state. */
interface Timer {
  handle: ReturnType<typeof setTimeout> | undefined;
  startedAt: number;
  remaining: number;
}
const timers = new Map<number, Timer>();

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t?.handle) clearTimeout(t.handle);
  timers.delete(id);
}

function armTimer(id: number, ms: number) {
  clearTimer(id);
  timers.set(id, {
    handle: setTimeout(() => {
      clearTimer(id);
      useNotifications.getState().dismiss(id);
    }, ms),
    startedAt: Date.now(),
    remaining: ms,
  });
}

/** (Re)schedule `id`'s auto-dismiss for `ms`. While the stack is paused the entry
 *  is stored frozen (no live handle) so `resumeTimers()` starts it with the full
 *  remaining time once the pointer leaves. Without this a toast that first gained
 *  a finite duration *during* hover (e.g. a push resolving to success while the
 *  stack is hovered) would have no `timers` entry and never auto-dismiss. */
function scheduleTimer(id: number, ms: number) {
  if (useNotifications.getState().paused) {
    clearTimer(id);
    timers.set(id, { handle: undefined, startedAt: Date.now(), remaining: ms });
  } else {
    armTimer(id, ms);
  }
}

export const useNotifications = create<NotifyState>((set, get) => ({
  toasts: [],
  paused: false,

  notify: (input) => {
    const id = (seq += 1);
    const duration = defaultDuration(input);
    const toast: Notification = {
      id,
      kind: input.kind ?? "info",
      title: input.title,
      body: input.body,
      actions: input.actions,
      progress: input.progress,
      duration,
      raw: input.raw,
    };
    set((s) => {
      const next = [...s.toasts, toast];
      while (next.length > MAX_VISIBLE) {
        // Never evict the toast we just added (it's last and the most relevant).
        // Among the older ones, prefer the oldest *dismissible* toast so in-flight
        // progress toasts survive to receive their resolve; only when every older
        // toast is progress do we sacrifice the oldest progress.
        const older = next.slice(0, -1);
        let idx = older.findIndex((t) => t.kind !== "progress");
        if (idx === -1) idx = 0;
        const [dropped] = next.splice(idx, 1);
        if (dropped) clearTimer(dropped.id);
      }
      return { toasts: next };
    });
    if (duration != null) scheduleTimer(id, duration);
    return id;
  },

  update: (id, patch) => {
    let existed = false;
    set((s) => ({
      toasts: s.toasts.map((t) => {
        if (t.id !== id) return t;
        existed = true;
        return { ...t, ...patch };
      }),
    }));
    if (!existed) return;
    // Reconcile the timer whenever the duration is patched (e.g. a progress toast
    // completing into a self-dismissing success, or a live toast's duration being
    // changed) — always clear then reschedule so the JS timeout and the CSS timer
    // bar can't drift apart, and a resolve during hover still registers.
    if (patch.duration !== undefined) {
      if (patch.duration == null) clearTimer(id);
      else scheduleTimer(id, patch.duration);
    }
  },

  dismiss: (id) => {
    clearTimer(id);
    set((s) => {
      if (!s.toasts.some((t) => t.id === id)) return s;
      return { toasts: s.toasts.filter((t) => t.id !== id) };
    });
  },

  dismissAll: () => {
    // Clear the whole timer map (not just current toasts') so no stale handle or
    // entry outlives the stack.
    timers.forEach((t) => {
      if (t.handle) clearTimeout(t.handle);
    });
    timers.clear();
    set((s) => (s.toasts.length === 0 ? s : { toasts: [] }));
  },

  pauseTimers: () => {
    if (get().paused) return;
    const now = Date.now();
    for (const [id, t] of timers) {
      if (t.handle) clearTimeout(t.handle);
      const remaining = Math.max(0, t.remaining - (now - t.startedAt));
      timers.set(id, { handle: undefined, startedAt: now, remaining });
    }
    set({ paused: true });
  },

  resumeTimers: () => {
    if (!get().paused) return;
    const now = Date.now();
    for (const [id, t] of timers) {
      if (t.handle) continue;
      timers.set(id, {
        handle: setTimeout(() => {
          clearTimer(id);
          useNotifications.getState().dismiss(id);
        }, t.remaining),
        startedAt: now,
        remaining: t.remaining,
      });
    }
    set({ paused: false });
  },
}));
