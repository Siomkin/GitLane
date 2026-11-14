// Progress and hook-output feedback for checkout writes. A checkout blocked on a
// slow hook (a post-checkout that starts containers, say) otherwise shows nothing
// while the hook runs, and whatever the hook printed is lost.

import { basename } from "@/lib/paths";
import { useNotifications } from "@/store/notifications";
import type { RepoGet, RepoSet } from "@/store/repoTypes";

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
  /** False when an enclosing `runPendingCheckout` already shows the card. */
  progress?: boolean;
}

export const TITLES: Record<CheckoutFeedbackMode, { busy: string; done: string }> = {
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

/** Post the "Checking out X…" card if `stop` hasn't been called by the delay. */
function delayedProgressCard(title: () => string): () => void {
  const notes = useNotifications.getState();
  let cardId: number | null = null;
  const timer = setTimeout(() => {
    cardId = notes.notify({ kind: "progress", title: title(), progress: "indeterminate" });
  }, CHECKOUT_PROGRESS_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (cardId !== null) notes.dismiss(cardId);
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
  { mode = "checkout", repoPath, isCurrent, progress = true }: CheckoutFeedbackOptions = {},
): Promise<string> {
  const titles = TITLES[mode];
  const stop = progress
    ? delayedProgressCard(() => `${titles.busy} ${label}${whereSuffix(repoPath, isCurrent)}…`)
    : () => {};
  let output: string;
  try {
    output = await run();
  } finally {
    stop();
  }
  const trimmed = output.trim();
  if (trimmed) {
    useNotifications.getState().notify({
      kind: "info",
      title: `${titles.done} ${label}${whereSuffix(repoPath, isCurrent)}`,
      body: clipOutput(trimmed),
      duration: CHECKOUT_OUTPUT_MS,
    });
  }
  return output;
}

/** A checkout asked for while another runs in the same repository. A pill
 *  double-click drops it silently; a menu that chains a write after the
 *  checkout surfaces it, so that write never runs without the checkout. */
export class CheckoutBusyError extends Error {
  constructor() {
    super("A checkout is already running. Try again when it finishes.");
    this.name = "CheckoutBusyError";
  }
}

export interface PendingCheckout {
  /** The ref the user acted on — `origin/develop` for a remote checkout. */
  ref: string;
  /** What the progress card names; read when the card appears. */
  label: () => string;
  repoPath: string;
  isCurrent: () => boolean;
}

/** Mark `ref` pending in `repoPath` for the whole checkout — worktree probe,
 *  git, and the refresh after it — with one delayed progress card over it all.
 *  Must be called before the action's first await so a second request in the
 *  same repository sees the pending checkout and is refused. */
export async function runPendingCheckout(
  set: RepoSet,
  get: RepoGet,
  { ref, label, repoPath, isCurrent }: PendingCheckout,
  body: () => Promise<string>,
): Promise<string> {
  if (repoPath in get().checkoutPending) throw new CheckoutBusyError();
  set({ checkoutPending: { ...get().checkoutPending, [repoPath]: ref } });
  const stop = delayedProgressCard(() => `${label()}${whereSuffix(repoPath, isCurrent)}…`);
  try {
    return await body();
  } finally {
    stop();
    // The guard above keeps this the repo's only run, so its entry is ours.
    const { [repoPath]: _done, ...rest } = get().checkoutPending;
    set({ checkoutPending: rest });
  }
}
