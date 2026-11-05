// What a successful credential save found when it checked the open
// repository's remotes on that host: accepted, refused, or not checked.

import type { RemoteCheck } from "@/store/accounts/credentialChecks";

export function RemoteCheckResults({ checks, note }: { checks: RemoteCheck[]; note: string | null }) {
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
              Saved — <span className="font-mono">{check.remote}</span> accepted it.
            </p>
          ) : check.kind === "auth" ? (
            <p key={check.remote} className="text-rose-600 dark:text-rose-400">
              <span className="font-mono">{check.remote}</span> refused it: {check.message}
            </p>
          ) : (
            <p key={check.remote} className="text-amber-600 dark:text-amber-400">
              Saved, but <span className="font-mono">{check.remote}</span> could not be checked: {check.message}
            </p>
          ),
        )
      )}
    </div>
  );
}
