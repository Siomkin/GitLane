// Progress and hook-output feedback for checkout writes. A checkout blocked on a
// slow hook (a post-checkout that starts containers, say) otherwise shows nothing
// while the hook runs, and whatever the hook printed is lost.

import { basename } from "@/lib/paths";
import { useNotifications } from "@/store/notifications";

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

/** Run a checkout write, showing a progress card if it outlasts the delay and,
 *  on success, the backend's output — git's own switch messages are dropped, so
 *  what is left is hook output and warnings, already secret-redacted. The body
 *  scrolls and is selectable. Failures propagate to the caller's toast. */
export async function withCheckoutFeedback(
  label: string,
  run: () => Promise<string>,
  { mode = "checkout", repoPath, isCurrent }: CheckoutFeedbackOptions = {},
): Promise<string> {
  const notes = useNotifications.getState();
  const titles = TITLES[mode];
  const where = () =>
    repoPath && isCurrent && !isCurrent() ? ` in ${basename(repoPath)}` : "";
  let cardId: number | null = null;
  const timer = setTimeout(() => {
    cardId = notes.notify({
      kind: "progress",
      title: `${titles.busy} ${label}${where()}…`,
      progress: "indeterminate",
    });
  }, CHECKOUT_PROGRESS_DELAY_MS);
  let output: string;
  try {
    output = await run();
  } finally {
    clearTimeout(timer);
    if (cardId !== null) notes.dismiss(cardId);
  }
  const trimmed = output.trim();
  if (trimmed) {
    notes.notify({
      kind: "info",
      title: `${titles.done} ${label}${where()}`,
      body: clipOutput(trimmed),
      duration: CHECKOUT_OUTPUT_MS,
    });
  }
  return output;
}
