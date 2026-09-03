// Failed secondary reads are surfaced, not blanked (unify-error-model, 4.1).
//
// A refresh reads several sections (worktrees, stashes, forge, operation
// status, remotes) that are best-effort next to the required graph/branches/
// changes lanes. Mapping a rejection to `[]`/`null` used to render the section
// as empty as if the repo had none. Instead each section keeps its last good
// value, is flagged in `useRepo.unavailableSections` with the error message,
// and raises ONE warning notification — only on the transition into the
// unavailable state, so watcher-driven refreshes that keep failing don't storm
// the toast stack. The next successful read of that section clears the flag
// and dismisses its notification.
//
// Ownership: callers decide *which* outcomes apply — a superseded request must
// not mutate state, so only the lanes still current contribute outcomes here.

import { useNotifications } from "@/store/notifications";
import type { RefreshSection, UnavailableSections } from "@/store/repoTypes";

/** Human labels for the "Couldn't read <section>" notification. */
export const SECTION_LABELS: Record<RefreshSection, string> = {
  worktrees: "worktrees",
  stashes: "stashes",
  forge: "the hosting provider",
  operation: "the operation status",
  remotes: "remotes",
};

/** Settle a section read into a `PromiseSettledResult` so a rejection never
 * rejects the enclosing `Promise.all` and the caller can decide what to keep. */
export const settleRead = <T>(read: Promise<T>): Promise<PromiseSettledResult<T>> =>
  read.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

/** The message to show for a rejection — a structured command error (an object
 * carrying `message`), an `Error`, or anything else stringified. */
export function sectionErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  if (error instanceof Error) return error.message;
  const text = String(error);
  return text === "[object Object]" ? "Unknown error" : text;
}

/** What a settled section read publishes: the fresh value on success, the
 * previous value on failure (never a blank), plus the failure message or null. */
export function resolveSectionRead<T>(
  read: PromiseSettledResult<T>,
  previous: T,
): { value: T; failure: string | null } {
  return read.status === "fulfilled"
    ? { value: read.value, failure: null }
    : { value: previous, failure: sectionErrorMessage(read.reason) };
}

/** Per-section outcome of one refresh: a message marks it unavailable, `null`
 * marks it healthy, and a section absent from the map is left as it was. */
export type SectionOutcomes = Partial<Record<RefreshSection, string | null>>;

export interface SectionAvailability {
  /** Spread into the same `set` as the section data. `{}` when nothing
   * changed, so the navigator's `unavailableSections` subscription keeps its
   * reference and doesn't re-render on a healthy refresh. */
  patch: { unavailableSections?: UnavailableSections };
  /** Raise the notification for each section that just became unavailable and
   * dismiss the one of each section that just recovered. Call after the patch
   * has been published. */
  notify: () => void;
}

/** The live notification per unavailable section, so a recovery can dismiss
 * it without user action. Module-level: the flag itself lives in the store. */
const sectionToasts = new Map<RefreshSection, number>();

export function planSectionAvailability(
  current: UnavailableSections,
  outcomes: SectionOutcomes,
): SectionAvailability {
  const next: UnavailableSections = { ...current };
  const failed: { section: RefreshSection; message: string }[] = [];
  const recovered: RefreshSection[] = [];
  let changed = false;
  for (const [key, outcome] of Object.entries(outcomes)) {
    const section = key as RefreshSection;
    if (outcome === undefined) continue;
    const was = current[section];
    if (outcome === null) {
      if (was === undefined) continue;
      delete next[section];
      recovered.push(section);
      changed = true;
    } else {
      // Keep the message current, but only announce the transition.
      if (was === undefined) failed.push({ section, message: outcome });
      if (was !== outcome) {
        next[section] = outcome;
        changed = true;
      }
    }
  }
  return {
    patch: changed ? { unavailableSections: next } : {},
    notify: () => {
      const notifications = useNotifications.getState();
      for (const section of recovered) {
        const id = sectionToasts.get(section);
        if (id !== undefined) notifications.dismiss(id);
        sectionToasts.delete(section);
      }
      for (const { section, message } of failed) {
        sectionToasts.set(
          section,
          notifications.notify({
            kind: "warning",
            title: `Couldn't read ${SECTION_LABELS[section]}`,
            body: message,
          }),
        );
      }
    },
  };
}

/** One-shot flag + notification for a section read that failed outside the
 * refresh pipeline. The caller has already confirmed it still owns the repo. */
export function reportSectionFailure(
  set: (patch: SectionAvailability["patch"]) => void,
  current: UnavailableSections,
  section: RefreshSection,
  error: unknown,
): void {
  const availability = planSectionAvailability(current, {
    [section]: sectionErrorMessage(error),
  });
  set(availability.patch);
  availability.notify();
}
