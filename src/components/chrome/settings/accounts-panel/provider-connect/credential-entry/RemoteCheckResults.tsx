// What a successful credential save found when it checked the open
// repository's remotes on that host: accepted, refused, or not checked.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { RemoteCheck } from "@/store/accounts/credentialChecks";
import { GitOutputDetails } from "./GitOutputDetails";

/** The GitHub token reminder: the post-save `ls-remote` proves read access only. */
export const GITHUB_READ_ONLY_NOTE =
  "The check only reads. Pushing also needs Contents: Read and write (fine-grained) or the repo scope (classic).";

export function RemoteCheckResults({
  checks,
  note,
  readOnlyNote,
  onUseGitlaneToken,
}: {
  checks: RemoteCheck[];
  note: string | null;
  /** Shown under an accepted check: what the read-only check did not prove. */
  readOnlyNote?: string;
  /** Offered when a remote got no credential at all (the helper didn't answer). */
  onUseGitlaneToken?: () => void;
}) {
  const nothingReached = checks.some((c) => !c.ok && c.code === "credentialsMissing");
  return (
    <div role="status" className="mt-2 flex flex-col gap-1 text-[12px] font-medium leading-snug">
      {note && <p className="text-neutral-500 dark:text-neutral-400">{note}</p>}
      {checks.length === 0 && note ? null : checks.length === 0 ? (
        <p className="text-emerald-600 dark:text-emerald-400">
          Saved. GitLane will use it on the next fetch, pull or push (not checked yet — no open remote uses this host).
        </p>
      ) : (
        checks.map((check) =>
          check.ok ? (
            <p key={check.remote} className="text-emerald-600 dark:text-emerald-400">
              Saved — <span className="font-mono">{check.remote}</span> accepted it{readOnlyNote ? " for reading" : ""}.
            </p>
          ) : check.kind === "auth" ? (
            <div key={check.remote} className="text-rose-600 dark:text-rose-400">
              <p>
                <span className="font-mono">{check.remote}</span> refused it: {check.message}
              </p>
              <GitOutputDetails detail={check.detail} />
            </div>
          ) : (
            <div key={check.remote} className="text-amber-600 dark:text-amber-400">
              <p>
                Saved, but <span className="font-mono">{check.remote}</span> could not be checked: {check.message}
              </p>
              <GitOutputDetails detail={check.detail} />
            </div>
          ),
        )
      )}
      {readOnlyNote && checks.some((c) => c.ok) && (
        <p className="font-normal text-neutral-500 dark:text-neutral-400">{readOnlyNote}</p>
      )}
      {nothingReached && onUseGitlaneToken && (
        <div>
          <button
            type="button"
            onClick={onUseGitlaneToken}
            className={cn(
              "mt-0.5 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[12px] font-semibold text-white",
              focusRing,
            )}
          >
            Use a GitLane token instead
          </button>
        </div>
      )}
    </div>
  );
}
