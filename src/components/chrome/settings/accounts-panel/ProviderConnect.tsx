// The connect path for one provider the user picked. Each state is visually
// and verbally distinct so "not installed", "not signed in", "manual", and
// "signed in but no PR support" never read alike — and none looks like a broken
// account. GitHub is the only full-support path; everything else is honest
// about auth-only / no-PRs.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { openExternalUrl } from "../../../../lib/openExternal";
import type { ForgeAuthStatus } from "../../../../lib/api";
import { accountHandle, connectState, providerInitials, type ProviderMeta } from "./providers";
import { CopyCommand } from "./CopyCommand";

const linkCls =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] hover:underline";
const refreshBtnCls =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]";

export function ProviderConnect({
  meta,
  status,
  accountLoading = false,
  onBack,
  onRefresh,
}: {
  meta: ProviderMeta;
  /** The provider's auth probe — `null` for GitHub (handled by the gh path). */
  status: ForgeAuthStatus | null;
  /** The background whoami for this provider is in flight (identity resolving). */
  accountLoading?: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const refresh = (
    <button onClick={onRefresh} className={cn(refreshBtnCls, focusRing)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
      Refresh
    </button>
  );

  return (
    <div className="rounded-xl border border-black/[0.08] bg-black/[0.015] p-4 dark:border-white/[0.1] dark:bg-white/[0.02]">
      {/* header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          aria-label="Back"
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
          {providerInitials(meta.name)}
        </span>
        <div className="text-[14px] font-semibold text-neutral-900 dark:text-white">Connect {meta.name}</div>
        {meta.prSupported ? (
          <span className="ml-auto inline-flex h-[18px] items-center rounded-full bg-emerald-500/12 px-2 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            Full support
          </span>
        ) : (
          <span className="ml-auto inline-flex h-[18px] items-center rounded-full bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
            Auth only — no PRs yet
          </span>
        )}
      </div>

      <div className="mt-3.5">
        {meta.key === "github" ? (
          <GithubConnect refresh={refresh} />
        ) : status ? (
          <ForgeConnect status={status} accountLoading={accountLoading} refresh={refresh} />
        ) : (
          <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400">No status available — press Refresh.</p>
        )}
      </div>
    </div>
  );
}

function StateBlock({
  title,
  body,
  children,
}: {
  title: string;
  body: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">{body}</p>
      {children && <div className="mt-3 flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

/** A numbered step in the manual connect walkthrough. */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.1] dark:text-neutral-300">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function GithubConnect({ refresh }: { refresh: React.ReactNode }) {
  return (
    <StateBlock
      title="Sign in with the GitHub CLI"
      body={
        <>
          Run the login command in a terminal, then Refresh. GitLane reads accounts from{" "}
          <code className="font-mono text-[12px]">gh</code> — pull requests, push, and fetch all work once you’re
          signed in.
        </>
      }
    >
      <CopyCommand command="gh auth login" />
      <div className="flex items-center gap-2">
        {refresh}
        <button onClick={() => openExternalUrl("https://cli.github.com")} className={cn(linkCls, "px-1")}>
          Install gh
        </button>
      </div>
    </StateBlock>
  );
}

function ForgeConnect({
  status,
  accountLoading,
  refresh,
}: {
  status: ForgeAuthStatus;
  accountLoading: boolean;
  refresh: React.ReactNode;
}) {
  const state = connectState(status);
  const cli = status.cli ?? "";

  if (state === "missing") {
    return (
      <StateBlock
        title={`Install the ${cli} CLI`}
        body={
          <>
            {status.forge} needs the <code className="font-mono text-[12px]">{cli}</code> command-line tool. It isn’t
            installed yet — this is a setup step, not a broken account.
          </>
        }
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => openExternalUrl(status.docsUrl)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
              focusRing,
            )}
          >
            Install {cli}
          </button>
          {refresh}
        </div>
        <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">{status.notes}</p>
      </StateBlock>
    );
  }

  if (state === "manual") {
    return (
      <StateBlock
        title="Connect with an API token"
        body={
          <>
            {status.forge} has no CLI — authenticate git over HTTPS with an Atlassian API token, saved by your git
            credential helper. Three steps:
          </>
        }
      >
        <ol className="flex flex-col gap-3.5">
          <Step n={1}>
            <div className="text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              Create an API token with the <code className="font-mono text-[11.5px]">read:repository:bitbucket</code>{" "}
              scope (add <code className="font-mono text-[11.5px]">write:repository:bitbucket</code> to push).
            </div>
            <button onClick={() => openExternalUrl(status.docsUrl)} className={cn(linkCls, "mt-1.5")}>
              <ExternalIcon />
              Create an API token
            </button>
          </Step>
          <Step n={2}>
            <div className="text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              Make sure git can store credentials — macOS uses the keychain by default, or set it explicitly:
            </div>
            <div className="mt-2">
              <CopyCommand command="git config --global credential.helper osxkeychain" />
            </div>
          </Step>
          <Step n={3}>
            <div className="text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
              Clone or push over HTTPS. When git prompts, enter:
            </div>
            <div className="mt-2 overflow-hidden rounded-lg border border-black/10 text-[12px] dark:border-white/10">
              <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.07]">
                <span className="w-[74px] shrink-0 text-neutral-400 dark:text-neutral-500">Username</span>
                <span className="font-mono text-neutral-700 dark:text-neutral-200">your Bitbucket username</span>
              </div>
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="w-[74px] shrink-0 text-neutral-400 dark:text-neutral-500">Password</span>
                <span className="font-mono text-neutral-700 dark:text-neutral-200">your API token</span>
              </div>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              Or use <code className="font-mono">x-bitbucket-api-token-auth</code> as the username. Git saves it via your
              credential helper, so you’re only asked once.
            </p>
          </Step>
        </ol>
      </StateBlock>
    );
  }

  if (state === "prunsupported") {
    const resolving = accountLoading && !status.account;
    return (
      <StateBlock
        title={
          status.account
            ? `Signed in as ${accountHandle(status.account)}`
            : resolving
              ? "Signed in — resolving account…"
              : `Signed in to ${cli}`
        }
        body={
          <>
            You’re authenticated, but <span className="font-medium text-neutral-700 dark:text-neutral-200">pull
            requests aren’t available for {status.forge} in GitLane yet</span>. Commit, fetch, and push still work via
            your git profile.
          </>
        }
      >
        {resolving && (
          <span className="h-3 w-40 animate-pulse rounded bg-black/10 dark:bg-white/15" aria-busy="true" />
        )}
        <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">{status.notes}</p>
      </StateBlock>
    );
  }

  // signin — CLI present, not signed in
  return (
    <StateBlock
      title={`${status.forge} CLI is installed, but not signed in`}
      body={
        <>
          Run the login command, then Refresh. Note: this authenticates {status.forge}, but GitLane has no pull-request
          support for it yet.
        </>
      }
    >
      <CopyCommand command={status.loginCommand} />
      <div className="flex items-center gap-3">
        {refresh}
        <button onClick={() => openExternalUrl(status.docsUrl)} className={linkCls}>
          Learn more
        </button>
      </div>
    </StateBlock>
  );
}
