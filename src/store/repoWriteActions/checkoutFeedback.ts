// Progress and hook-output feedback for checkout writes. A checkout blocked on a
// slow hook (a post-checkout that starts containers, say) otherwise shows nothing
// while the hook runs, and whatever the hook printed is lost.

import { useNotifications } from "@/store/notifications";

/** Ordinary checkouts finish well inside this; anything hook-bound shows a card. */
export const CHECKOUT_PROGRESS_DELAY_MS = 400;
/** The tail of hook output is usually the verdict ("ready", "failed"). */
const MAX_OUTPUT_LINES = 12;

/** Run a checkout write, showing a progress card if it outlasts the delay and,
 *  on success, the backend's output — quiet git leaves only hook output and
 *  warnings, already secret-redacted. Failures propagate to the caller's toast. */
export async function withCheckoutFeedback(
  label: string,
  run: () => Promise<string>,
): Promise<string> {
  const notes = useNotifications.getState();
  let cardId: number | null = null;
  const timer = setTimeout(() => {
    cardId = notes.notify({
      kind: "progress",
      title: `Checking out ${label}…`,
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
      title: `Checked out ${label}`,
      body: trimmed.split("\n").slice(-MAX_OUTPUT_LINES).join("\n"),
    });
  }
  return output;
}
