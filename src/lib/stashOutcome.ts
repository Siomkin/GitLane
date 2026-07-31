// Classify the success output of the `stash` / `stash_file` commands. A routine
// stash normalises backend-side to one short sentence ("Stashed <label>."); a
// stash whose untracked cleanup Git could not finish still succeeds, but the
// message then carries what GitLane completed *and* what it had to leave on
// disk. The routine case is silent (the stash list is the confirmation) — the
// split-state case must not land silently, so it still toasts.
//
// The discriminator is sentence count, not length: labels routinely contain
// dots ("Stashed src/a.ts.") but never ". ", which only appears where the
// backend appended a second sentence of recovery detail.

const ROUTINE = /^Stashed .+\.$/;

/** True when a successful stash was routine — one short sentence, nothing left
 *  behind — so the outcome needs no toast. */
export function stashWasRoutine(message: string): boolean {
  return ROUTINE.test(message) && !message.includes(". ");
}
