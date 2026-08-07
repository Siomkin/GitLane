// The in-app GitHub sign-in modal (GL-106): pick a host and start, watch the live
// device-flow checklist (one-time code + copy, "opening {host}", "waiting for
// authorization…", "account added"), then land on the new account with an offer
// to bind it to the open repo. Follows the GL-105 hand-off dialog shell and the
// shared step checklist. Cancel kills the gh child; closing mid-run cancels it too.

import { useState } from "react";
import {
  DIALOG_LAYER,
  DialogCloseRow,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";

import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/openExternal";
import { CheckIcon, GitHubIcon, WarningIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/Select";
import { focusRing } from "@/lib/ui";
import { InlineSpinner } from "@/components/ui/Loading";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { useUi, type GithubSigninRequest } from "@/store/ui";
import { StepRow } from "@/components/chrome/overlays/progress";
import { SIGNIN_STEP_COUNT, signinStepLabel, signinStepStatus } from "./steps";
import { githubSigninCommand } from "./signinCommand";
import { useGithubSigninRun } from "./useGithubSigninRun";

export function GithubSigninDialog() {
  const req = useUi((s) => s.githubSignin);
  if (!req) return null;
  // Keyed so reopening (or a different host) always starts a fresh flow.
  return <GithubSigninDialogBody key={req.host} req={req} />;
}

function GithubSigninDialogBody({ req }: { req: GithubSigninRequest }) {
  const closeGithubSignin = useUi((s) => s.closeGithubSignin);
  const setRepoAccount = useAccounts((s) => s.setRepoAccount);
  const repoPath = useRepo((s) => s.summary?.path);
  const run = useGithubSigninRun();

  const [mode, setMode] = useState<"dotcom" | "enterprise">(
    req.host === "github.com" || req.host === "" ? "dotcom" : "enterprise",
  );
  const [host, setHost] = useState(req.host === "" ? "github.com" : req.host);
  const [copied, setCopied] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const effectiveHost = mode === "dotcom" ? "github.com" : host.trim();

  // The escape hatch when the in-app flow can't finish (a gh version whose
  // prompts we can't drive, a locked-down keychain, an odd shell env): `gh` owns
  // the credentials either way, so a plain terminal login lands in exactly the
  // same place and GitLane picks the account up on the next accounts refresh.
  const manualCommand = githubSigninCommand(effectiveHost);

  const close = () => {
    if (run.phase === "running") run.cancel();
    closeGithubSignin();
  };


  const copyCode = async () => {
    if (!run.code) return;
    try {
      await navigator.clipboard?.writeText(run.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard?.writeText(manualCommand);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 1400);
    } catch {
      /* clipboard unavailable — the command is shown for manual copy */
    }
  };

  const bind = async () => {
    if (run.done?.accountId) await setRepoAccount(run.done.accountId);
    closeGithubSignin();
  };

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
        <GitHubIcon className="h-[22px] w-[22px]" />
      </span>
    );

  return (
    <ModalFrame
      z={DIALOG_LAYER.Top}
      label="Sign in to GitHub"
      // Mid-run a stray backdrop click shouldn't drop the progress view; the
      // explicit close button (and Escape) still work.
      backdropDismiss={run.phase !== "running"}
      panelClassName="w-[440px]"
      onDismiss={close}
    >
      <DialogCloseRow onClose={close} badge={badge} />

      {run.phase === "configure" && (
        <>
          <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            Sign in to GitHub
          </div>
          <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
            Authorize GitLane in your browser with a one-time code — GitLane reads the account from{" "}
            <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-neutral-700 dark:bg-white/[0.07] dark:text-neutral-200">
              gh
            </span>
            . No password leaves your machine.
          </div>
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-neutral-500 dark:text-neutral-400">
            <span className="shrink-0">Host</span>
            <Select
              wrapperClassName="min-w-0 flex-1"
              value={mode}
              onChange={(e) => setMode(e.target.value as "dotcom" | "enterprise")}
              aria-label="GitHub host"
              className={cn(
                "h-9 w-full rounded-md border border-black/10 bg-white pl-2.5 text-[12.5px] font-medium text-neutral-700 focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200",
                focusRing,
              )}
            >
              <option value="dotcom" className="dark:bg-neutral-800">
                GitHub.com
              </option>
              <option value="enterprise" className="dark:bg-neutral-800">
                GitHub Enterprise…
              </option>
            </Select>
          </div>
          {mode === "enterprise" && (
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="github.your-company.com"
              aria-label="Enterprise host"
              className="mt-2 h-9 w-full rounded-md border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200"
            />
          )}
          <button
            type="button"
            onClick={() => run.start(effectiveHost)}
            disabled={!effectiveHost}
            className="mt-5 h-10 w-full rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            Sign in
          </button>
        </>
      )}

      {run.phase === "running" && (
        <>
          <div className="mt-3 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            Enter this code at {effectiveHost}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-black/10 bg-black/[0.02] px-4 py-3.5 dark:border-white/10 dark:bg-white/[0.03]">
            {run.code ? (
              <>
                <span className="font-mono text-[26px] font-semibold tracking-[0.24em] text-neutral-800 dark:text-neutral-100">
                  {run.code}
                </span>
                <button
                  type="button"
                  onClick={copyCode}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] px-2.5 text-[12px] font-semibold text-neutral-700 hover:bg-black/[0.06] dark:border-white/10 dark:bg-white/[0.05] dark:text-neutral-200 dark:hover:bg-white/10",
                    focusRing,
                  )}
                >
                  {copied ? <CheckIcon className="h-4 w-4 text-emerald-500" /> : null}
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
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
              `A browser will open to ${effectiveHost}/login/device`
            )}
          </div>

          <div className="mt-5 flex flex-col gap-3.5 pb-1">
            {Array.from({ length: SIGNIN_STEP_COUNT }, (_, i) => {
              const status = signinStepStatus(i, run.reached, false);
              return (
                <StepRow
                  key={i}
                  label={signinStepLabel(i, effectiveHost, status === "done")}
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
          <div className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
            {run.done.login ? (
              <>
                Signed in as
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold text-white"
                    style={{ background: "#5b8def" }}
                  >
                    {initials(run.done.login)}
                  </span>
                  @{run.done.login}
                </span>
              </>
            ) : (
              <>Signed in to {run.done.host}</>
            )}
          </div>
          {run.done.accountId && repoPath ? (
            <>
              <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
                Use this account for pull requests, fetch, and push in this repo?
              </div>
              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  onClick={closeGithubSignin}
                  className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
                >
                  Not now
                </button>
                <button
                  type="button"
                  onClick={bind}
                  className="h-10 flex-1 rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110"
                >
                  Use for this repo
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">
                Added on {run.done.host}. It’s ready for pull requests, fetch, and push.
              </div>
              <button
                type="button"
                autoFocus
                onClick={closeGithubSignin}
                className="mt-5 h-10 w-full rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
              >
                Done
              </button>
            </>
          )}
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

          <div className="mt-4 rounded-xl border border-black/10 bg-black/[0.02] px-3.5 py-3 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              You can also sign in from a terminal — GitLane picks the account up from{" "}
              <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-neutral-700 dark:bg-white/[0.07] dark:text-neutral-200">
                gh
              </span>{" "}
              once it’s done.
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-black/10 bg-white/60 px-2.5 py-1.5 font-mono text-[11.5px] text-neutral-700 dark:border-white/10 dark:bg-black/20 dark:text-neutral-200">
                {manualCommand}
              </code>
              <button
                type="button"
                onClick={copyCommand}
                aria-label="Copy sign-in command"
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.03] px-2.5 text-[12px] font-semibold text-neutral-700 hover:bg-black/[0.06] dark:border-white/10 dark:bg-white/[0.05] dark:text-neutral-200 dark:hover:bg-white/10",
                  focusRing,
                )}
              >
                {copiedCommand ? <CheckIcon className="h-4 w-4 text-emerald-500" /> : null}
                {copiedCommand ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={closeGithubSignin}
              className="h-10 flex-1 rounded-xl border border-black/10 text-[13.5px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => run.start(effectiveHost)}
              disabled={!effectiveHost}
              className="h-10 flex-1 rounded-xl bg-[var(--accent)] text-[13.5px] font-medium text-white hover:brightness-110 disabled:opacity-45"
            >
              Try again
            </button>
          </div>
        </>
      )}
    </ModalFrame>
  );
}

/** First two alphanumerics of a login, upper-cased, for the avatar chip. */
function initials(login: string): string {
  const cleaned = login.replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned.slice(0, 2) || "GH").toUpperCase();
}

/** Trim the scheme so the verification URL reads compactly in the hint line. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
