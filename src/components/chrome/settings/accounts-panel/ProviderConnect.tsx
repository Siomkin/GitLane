// The connect path for one provider the user picked. Each state is visually
// and verbally distinct so "not installed", "not signed in", "manual", and
// "signed in but no PR support" never read alike — and none looks like a broken
// account. GitHub is the only full-support path; everything else is honest
// about auth-only / no-PRs.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { openExternalUrl } from "../../../../lib/openExternal";
import type { ForgeAuthStatus } from "../../../../lib/api";
import { useUi } from "../../../../store/ui";
import { useAccounts } from "../../../../store/accounts";
import { accountHandle, connectState, providerInitials, type ProviderMeta } from "./providers";
import { CopyCommand } from "./CopyCommand";
import { useState } from "react";

const linkCls =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] hover:underline";
const refreshBtnCls =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]";

const DEFAULT_CREDENTIAL_HOST: Record<string, string> = {
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  "azure-devops": "dev.azure.com",
};

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
  /** Back affordance for the picker-flow embedding; omit in the persistent
   * provider-sidebar layout (Settings → Accounts), where there is no "back". */
  onBack?: () => void;
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
        {onBack && (
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
        )}
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
            Sign-in only
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

function CredentialHelperForm({
  status,
  usernameHint,
}: {
  status: ForgeAuthStatus;
  usernameHint?: string | null;
}) {
  const saveHttpsCredential = useAccounts((s) => s.saveHttpsCredential);
  const [host, setHost] = useState(DEFAULT_CREDENTIAL_HOST[status.provider] ?? "");
  const [path, setPath] = useState("");
  const [username, setUsername] = useState(usernameHint ?? "");
  const [password, setPassword] = useState("");
  const disabled = host.trim() === "" || username.trim() === "" || password === "";
  return (
    <div className="rounded-lg border border-black/[0.07] bg-white p-3 dark:border-white/[0.08] dark:bg-neutral-900/40">
      <div className="text-[12px] font-semibold text-neutral-700 dark:text-neutral-200">
        Save HTTPS credential in Git helper
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="Host"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        />
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Path scope (optional)"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="HTTPS username"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Token / password"
          type="password"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] text-neutral-700 placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void saveHttpsCredential(host, path.trim() || null, username, password).then(() => setPassword(""));
          }}
          className={cn(
            "h-9 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40",
            focusRing,
          )}
        >
          Save credential
        </button>
        <span className="text-[11.5px] leading-snug text-neutral-400 dark:text-neutral-500">
          GitLane sends this once to <span className="font-mono">git credential approve</span>; your configured helper
          stores it.
        </span>
      </div>
    </div>
  );
}

function GithubConnect({ refresh }: { refresh: React.ReactNode }) {
  const openGithubSignin = useUi((s) => s.openGithubSignin);
  return (
    <StateBlock
      title="Sign in to GitHub"
      body={
        <>
          Authorize GitLane in your browser with a one-time code — no terminal needed. GitLane reads the account from{" "}
          <code className="font-mono text-[12px]">gh</code>, so pull requests, push, and fetch all work once you’re
          signed in.
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => openGithubSignin("github.com")}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
            focusRing,
          )}
        >
          Sign in
        </button>
        {refresh}
        <button onClick={() => openExternalUrl("https://cli.github.com")} className={cn(linkCls, "px-1")}>
          Install gh
        </button>
      </div>
      <details className="text-[12px] text-neutral-500 dark:text-neutral-400">
        <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200">
          Prefer the terminal?
        </summary>
        <div className="mt-2">
          <CopyCommand command="gh auth login" />
        </div>
      </details>
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
            {status.forge} has no CLI. Create an API token, then save it to your Git credential helper from here.
          </>
        }
      >
        <button onClick={() => openExternalUrl(status.docsUrl)} className={linkCls}>
          <ExternalIcon />
          Create an API token
        </button>
        <CredentialHelperForm status={status} />
        <p className="text-[11.5px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          Bitbucket usually uses your Bitbucket username with an API token as the password. Some token types use{" "}
          <code className="font-mono">x-bitbucket-api-token-auth</code> as the username.
        </p>
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
            requests aren’t available for {status.forge} in GitLane yet</span>. Clone, fetch, pull, and push use each
            remote’s HTTPS username plus your git credential helper.
          </>
        }
      >
        {resolving && (
          <span className="h-3 w-40 animate-pulse rounded bg-black/10 dark:bg-white/15" aria-busy="true" />
        )}
        <CredentialHelperForm status={status} usernameHint={status.account?.username} />
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
          Run the login command, then Refresh. Git transport still uses HTTPS usernames and your git credential helper;
          pull requests are not available for this provider yet.
        </>
      }
    >
      <CopyCommand command={status.loginCommand} />
      <CredentialHelperForm status={status} />
      <div className="flex items-center gap-3">
        {refresh}
        <button onClick={() => openExternalUrl(status.docsUrl)} className={linkCls}>
          Learn more
        </button>
      </div>
    </StateBlock>
  );
}
