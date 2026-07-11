// The native provider OAuth sign-in modal (GL-139): sign in to GitLab (device
// flow — a one-time code) or Bitbucket (PKCE loopback — a browser round-trip),
// watch the live checklist, then land on the connected account. The resolved
// token is stored in the OS keychain by the backend; nothing secret reaches here.
// Follows the GL-106 GitHub sign-in shell and the shared step checklist. Cancel /
// close discards the codes and stops the flow.

import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import {
  BitbucketIcon,
  CheckIcon,
  CloseIcon,
  GitLabIcon,
  KeyIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import { useUi, type ProviderOauthSigninRequest } from "@/store/ui";
import { StepRow } from "../progress";
import { oauthModeFor, oauthStepCount, oauthStepLabel, oauthStepStatus } from "./steps";
import { useProviderOauthRun } from "./useProviderOauthRun";

const FORGE: Record<string, { name: string; Icon: typeof KeyIcon }> = {
  gitlab: { name: "GitLab", Icon: GitLabIcon },
  bitbucket: { name: "Bitbucket", Icon: BitbucketIcon },
};

export function ProviderOauthDialog() {
  const req = useUi((s) => s.providerOauthSignin);
  if (!req) return null;
  // Keyed so reopening always starts a fresh flow.
  return <ProviderOauthDialogBody key={`${req.provider}:${req.host}:${req.remote ?? ""}`} req={req} />;
}

function ProviderOauthDialogBody({ req }: { req: ProviderOauthSigninRequest }) {
  const close = useUi((s) => s.closeProviderOauthSignin);
  const run = useProviderOauthRun(req);
  const mode = oauthModeFor(req.provider);
  const forge = FORGE[req.provider] ?? { name: req.provider, Icon: KeyIcon };

  const dismiss = () => {
    if (run.phase === "running") run.cancel();
    close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.phase]);

  const badge =
    run.phase === "done" ? (
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400">
        <CheckIcon className="h-5 w-5" />
      </span>
    ) : run.phase === "error" ? (
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-rose-500/15 text-rose-600 dark:bg-rose-400/15 dark:text-rose-400">
        <WarningIcon className="h-5 w-5" />
      </span>
    ) : (
      <span className="grid h-10 w-10 place-items-center rounded-xl border border-black/10 bg-black/[0.025] text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200">
        <forge.Icon className="h-[22px] w-[22px]" />
      </span>
    );

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={run.phase === "running" ? undefined : dismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Sign in to ${forge.name}`}
        className="w-[440px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="flex items-start justify-between">
          {badge}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close dialog"
            className={cn(
              "grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {run.phase === "configure" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Sign in to {forge.name}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              {mode === "device"
                ? `Authorize GitLane on ${req.host} with a one-time code. `
                : `Authorize GitLane in your browser on ${req.host}. `}
              The token is stored in your OS keychain and fed to git for you — it never leaves your
              machine.
            </div>
            <button
              type="button"
              onClick={run.start}
              className="mt-5 h-10 w-full rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110"
            >
              Sign in to {forge.name}
            </button>
          </>
        )}

        {run.phase === "running" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              {mode === "device" ? `Enter this code at ${req.host}` : `Authorize in your browser`}
            </div>

            {mode === "device" && (
              <>
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-3.5 dark:border-white/10 dark:bg-white/[0.03]">
                  {run.code ? (
                    <span className="font-mono text-[26px] font-semibold tracking-[0.2em] text-neutral-800 dark:text-neutral-100">
                      {run.code}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2 text-[13px] text-neutral-400">
                      <InlineSpinner className="h-4 w-4" />
                      Requesting a one-time code…
                    </span>
                  )}
                </div>
                <div className="mt-2 text-center text-[11.5px] text-neutral-400">
                  {run.url ? (
                    <button
                      type="button"
                      onClick={() => run.url && openExternalUrl(run.url)}
                      className="hover:text-neutral-600 hover:underline dark:hover:text-neutral-300"
                    >
                      Didn’t open? Open {displayUrl(run.url)}
                    </button>
                  ) : (
                    `A browser will open to ${req.host}`
                  )}
                </div>
              </>
            )}

            {mode === "pkce" && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-3.5 text-[13px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">
                <InlineSpinner className="h-4 w-4 shrink-0" />
                <span>
                  Approve GitLane in the browser tab that opened.{" "}
                  {run.url && (
                    <button
                      type="button"
                      onClick={() => run.url && openExternalUrl(run.url)}
                      className="underline hover:text-neutral-700 dark:hover:text-neutral-200"
                    >
                      Didn’t open?
                    </button>
                  )}
                </span>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-3.5 pb-1">
              {Array.from({ length: oauthStepCount(mode) }, (_, i) => {
                const status = oauthStepStatus(i, run.reached, false);
                const label = oauthStepLabel(mode, i, req.host, status === "done");
                return (
                  <StepRow
                    // This fixed checklist never inserts, removes, or reorders steps.
                    key={i}
                    label={label}
                    status={status}
                  />
                );
              })}
            </div>
            <button
              type="button"
              onClick={run.cancel}
              className="mt-5 h-10 w-full rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              Cancel
            </button>
          </>
        )}

        {run.phase === "done" && run.done && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Signed in as @{run.done.login}
            </div>
            <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
              {run.done.boundRemote
                ? `${run.done.boundRemote} now authenticates as this account — fetch and push use your keychain token.`
                : `Fetch, push, and clone for ${run.done.host} now authenticate with this token automatically — no per-remote setup. Manage it in Settings → Accounts.`}
            </div>
            <button
              type="button"
              autoFocus
              onClick={close}
              className="mt-5 h-10 w-full rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              Done
            </button>
          </>
        )}

        {run.phase === "error" && (
          <>
            <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
              Sign-in didn’t finish
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-neutral-400">
              {run.message}
            </div>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={close}
                className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                Close
              </button>
              <button
                type="button"
                onClick={run.start}
                className="h-10 flex-1 rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110"
              >
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Trim the scheme so the verification URL reads compactly in the hint line. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
