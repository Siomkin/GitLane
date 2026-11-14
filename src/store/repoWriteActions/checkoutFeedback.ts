// Progress and hook-output feedback for checkout writes. A checkout blocked on a
// slow hook (a post-checkout that starts containers, say) otherwise shows nothing
// while the hook runs, and whatever the hook printed is lost.

import type { RepoSummary } from "@/lib/api";
import {
  CheckoutBusyError,
  checkoutKey,
  type PendingCheckoutRef,
} from "@/lib/checkoutPending";
import { basename } from "@/lib/paths";
import { useNotifications } from "@/store/notifications";
import type { RepoGet, RepoSet } from "@/store/repoTypes";
import { captureOwner, ownerIsCurrent, type RepoWriteOwner } from "./shared";

/** Ordinary checkouts finish well inside this; anything hook-bound shows a card. */
export const CHECKOUT_PROGRESS_DELAY_MS = 400;
/** Long enough to read a hook's verdict; hovering the stack pauses it. */
export const CHECKOUT_OUTPUT_MS = 15_000;
/** Git's warnings come first and a hook's verdict comes last; a verbose hook's
 *  middle is cut so the card stays light. */
export const OUTPUT_HEAD_LINES = 8;
export const OUTPUT_TAIL_LINES = 30;

/** "checkout" switches to `label`; "update" advances a branch that is already
 *  checked out in another worktree, where nothing is switched. */
export type CheckoutFeedbackMode = "checkout" | "update";

export interface CheckoutFeedbackOptions {
  mode?: CheckoutFeedbackMode;
  /** The repository the checkout runs in. Once `isCurrent` says it is no longer
   *  the open one, the cards name it so they aren't read as the visible repo's. */
  repoPath?: string;
  isCurrent?: () => boolean;
  /** Ends the progress card of an enclosing `runPendingCheckout`. When given,
   *  this call shows no card of its own and ends that one before posting the
   *  hook output, so "Checking out" and "Checked out" never show together. */
  endProgress?: () => void;
}

const TITLES: Record<CheckoutFeedbackMode, { busy: string; done: string }> = {
  checkout: { busy: "Checking out", done: "Checked out" },
  update: { busy: "Updating", done: "Updated" },
};

/** Keep the first and last lines of long output, eliding the middle. */
export function clipOutput(text: string): string {
  const lines = text.split("\n");
  const keep = OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES;
  if (lines.length <= keep + 1) return text;
  return [
    ...lines.slice(0, OUTPUT_HEAD_LINES),
    `… ${lines.length - keep} lines omitted …`,
    ...lines.slice(-OUTPUT_TAIL_LINES),
  ].join("\n");
}

/** Post the "Checking out X…" card if the returned stop hasn't been called by
 *  the delay. Stopping twice is harmless. */
function delayedProgressCard(title: () => string): () => void {
  const notes = useNotifications.getState();
  let cardId: number | null = null;
  const timer = setTimeout(() => {
    cardId = notes.notify({ kind: "progress", title: title(), progress: "indeterminate" });
  }, CHECKOUT_PROGRESS_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (cardId !== null) notes.dismiss(cardId);
    cardId = null;
  };
}

const whereSuffix = (repoPath?: string, isCurrent?: () => boolean) =>
  repoPath && isCurrent && !isCurrent() ? ` in ${basename(repoPath)}` : "";

/** Run a checkout write, showing a progress card if it outlasts the delay and,
 *  on success, the backend's output — git's own switch messages are dropped, so
 *  what is left is hook output and warnings, already secret-redacted. The body
 *  scrolls and is selectable. Failures propagate to the caller's toast. */
export async function withCheckoutFeedback(
  label: string,
  run: () => Promise<string>,
  { mode = "checkout", repoPath, isCurrent, endProgress }: CheckoutFeedbackOptions = {},
): Promise<string> {
  const titles = TITLES[mode];
  const stop = endProgress
    ? () => {}
    : delayedProgressCard(() => `${titles.busy} ${label}${whereSuffix(repoPath, isCurrent)}…`);
  let output: string;
  try {
    output = await run();
  } finally {
    stop();
  }
  const trimmed = output.trim();
  if (trimmed) {
    endProgress?.();
    useNotifications.getState().notify({
      kind: "info",
      title: `${titles.done} ${label}${whereSuffix(repoPath, isCurrent)}`,
      body: clipOutput(trimmed),
      duration: CHECKOUT_OUTPUT_MS,
    });
  }
  return output;
}

/** Record `ref` as the checkout running at `path`, or throw `CheckoutBusyError`
 *  if one already runs there. Check and set are synchronous, so two requests
 *  can't both pass. Returns the release, which only ever removes this entry. */
export function claimCheckout(
  set: RepoSet,
  get: RepoGet,
  path: string,
  { ref, kind }: PendingCheckoutRef,
): () => void {
  const key = checkoutKey(path);
  const running = get().checkoutPending[key];
  if (running) throw new CheckoutBusyError(running);
  const entry: PendingCheckoutRef = { ref, kind };
  set({ checkoutPending: { ...get().checkoutPending, [key]: entry } });
  return () => {
    if (get().checkoutPending[key] !== entry) return;
    const { [key]: _released, ...rest } = get().checkoutPending;
    set({ checkoutPending: rest });
  };
}

/** Run a write that switches the open working tree (merge, rebase, reset)
 *  unless a checkout is running there, which it would race. */
export function unlessCheckingOut(get: RepoGet, run: () => Promise<string>): Promise<string> {
  const path = get().summary?.path;
  const running = path ? get().checkoutPending[checkoutKey(path)] : undefined;
  return running ? Promise.reject(new CheckoutBusyError(running)) : run();
}

export interface CheckoutTarget extends PendingCheckoutRef {
  /** What the progress card names after "Checking out". */
  label: string;
  /** Read when the card appears: a remote checkout turns into "update" once
   *  its probe finds the branch in another worktree. */
  mode?: () => CheckoutFeedbackMode;
}

/** Run a checkout of the open repository as its one pending checkout: the ref
 *  is recorded (the pill spins) and claimed before anything is awaited, and one
 *  delayed progress card spans the whole body — worktree probe, git, refresh.
 *  The body gets `endProgress` to hand to `withCheckoutFeedback`. */
export function runPendingCheckout(
  set: RepoSet,
  get: RepoGet,
  target: CheckoutTarget,
  body: (summary: RepoSummary, owner: RepoWriteOwner, endProgress: () => void) => Promise<string>,
): Promise<string> {
  const { summary } = get();
  if (!summary) return Promise.reject(new Error("No repository"));
  const owner = captureOwner(summary);
  let release: () => void;
  try {
    release = claimCheckout(set, get, summary.path, target);
  } catch (e) {
    return Promise.reject(e);
  }
  const endProgress = delayedProgressCard(
    () =>
      `${TITLES[target.mode?.() ?? "checkout"].busy} ${target.label}` +
      `${whereSuffix(owner.path, () => ownerIsCurrent(get, owner))}…`,
  );
  return body(summary, owner, endProgress).finally(() => {
    endProgress();
    release();
  });
}
