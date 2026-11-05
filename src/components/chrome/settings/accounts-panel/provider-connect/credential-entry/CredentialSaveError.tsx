// The inline failure of a credential save, with the one recovery that fits it:
// forget the entry another helper returned instead, fall back to the Git
// credential helper when the keychain is unavailable, or switch to a GitLane
// token. Rendered inside the form, never as a toast (Settings is a modal).

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { CredentialSaveOutcome } from "@/store/accounts/credentialChecks";

type Failure = Extract<CredentialSaveOutcome, { ok: false }>;

const actionCls = cn(
  "rounded-lg border border-rose-500/30 px-2.5 py-1 text-[12px] font-semibold text-rose-700 transition hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-300",
  focusRing,
);

export function CredentialSaveError({
  failure,
  busy = false,
  keychainFailed = false,
  onForgetShadowed,
  onUseHelper,
  onUseGitlaneToken,
}: {
  failure: Failure;
  busy?: boolean;
  /** The keychain already failed earlier in this flow, so a missing helper
   * means neither storage is available. */
  keychainFailed?: boolean;
  onForgetShadowed?: (username: string) => void;
  onUseHelper?: () => void;
  onUseGitlaneToken?: () => void;
}) {
  const neither = failure.noCredentialHelper && keychainFailed;
  return (
    <div
      role="alert"
      className="mt-2 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-[12px] leading-relaxed text-rose-700 dark:text-rose-300"
    >
      <p>
        {failure.keychainUnavailable
          ? `GitLane could not store the token in your system keychain: ${failure.message}`
          : neither
            ? "This computer has neither secure storage nor a Git credential helper, so GitLane cannot save an HTTPS token here. Use an SSH key for this remote instead."
            : failure.message}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {failure.shadowedUsername && onForgetShadowed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onForgetShadowed(failure.shadowedUsername!)}
            className={actionCls}
          >
            Forget @{failure.shadowedUsername} and save again
          </button>
        )}
        {failure.keychainUnavailable && onUseHelper && (
          <button type="button" disabled={busy} onClick={onUseHelper} className={actionCls}>
            Save with Git credential helper instead
          </button>
        )}
        {failure.shadowedUsername && onUseGitlaneToken && (
          <button type="button" disabled={busy} onClick={onUseGitlaneToken} className={actionCls}>
            Use a GitLane token instead
          </button>
        )}
      </div>
    </div>
  );
}
