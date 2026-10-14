// Progress and hook-output feedback for checkout writes. A checkout blocked on a
// slow hook (a post-checkout that starts containers, say) otherwise shows nothing
// while the hook runs, and whatever the hook printed is lost.

import { useNotifications } from "@/store/notifications";

/** Ordinary checkouts finish well inside this; anything hook-bound shows a card. */
export const CHECKOUT_PROGRESS_DELAY_MS = 400;
/** Long enough to read a hook's verdict; hovering the stack pauses it. */
export const CHECKOUT_OUTPUT_MS = 15_000;

/** "checkout" switches to `label`; "update" advances a branch that is already
 *  checked out in another worktree, where nothing is switched. */
export type CheckoutFeedbackMode = "checkout" | "update";

const TITLES: Record<CheckoutFeedbackMode, { busy: string; done: string }> = {
  checkout: { busy: "Checking out", done: "Checked out" },
  update: { busy: "Updating", done: "Updated" },
};

/** Run a checkout write, showing a progress card if it outlasts the delay and,
 *  on success, the backend's output — git's own switch messages are dropped, so
 *  what is left is hook output and warnings, already secret-redacted. The body
 *  scrolls and is selectable. Failures propagate to the caller's toast. */
export async function withCheckoutFeedback(
  label: string,
  run: () => Promise<string>,
  mode: CheckoutFeedbackMode = "checkout",
): Promise<string> {
  const notes = useNotifications.getState();
  const titles = TITLES[mode];
  let cardId: number | null = null;
  const timer = setTimeout(() => {
    cardId = notes.notify({
      kind: "progress",
      title: `${titles.busy} ${label}…`,
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
      title: `${titles.done} ${label}`,
      body: trimmed,
      duration: CHECKOUT_OUTPUT_MS,
    });
  }
  return output;
}
