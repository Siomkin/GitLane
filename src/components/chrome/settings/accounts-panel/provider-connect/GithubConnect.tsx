// GitHub's preferred path is `gh` because it powers pull requests and can answer
// git credential prompts. GCM/helper and SSH are still valid transport-only
// fallbacks for users who do not install gh or do not need PRs in GitLane.

import { cn } from "../../../../../lib/cn";
import { focusRing } from "../../../../../lib/ui";
import { openExternalUrl } from "../../../../../lib/openExternal";
import { useUi } from "../../../../../store/ui";
import { CopyCommand } from "../CopyCommand";
import { CredentialEntryForm } from "./credential-entry";
import { MethodCard } from "./MethodCard";
import { ExternalIcon, KeyIcon, LockIcon, TerminalIcon, linkCls } from "./ui";

const GCM_URL = "https://github.com/git-ecosystem/git-credential-manager#git-credential-manager";

export function GithubConnect({ refresh }: { refresh: React.ReactNode }) {
  const openGithubSignin = useUi((s) => s.openGithubSignin);
  return (
    <div className="flex flex-col gap-3">
      <MethodCard icon={<TerminalIcon />} title="GitHub CLI" recommended>
        <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          Authorize GitLane in your browser with a one-time code. GitLane reads the account from{" "}
          <code className="font-mono text-[12px]">gh</code>, so pull requests and git transport both work.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
        <details className="mt-2 text-[12px] text-neutral-500 dark:text-neutral-400">
          <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200">
            Prefer the terminal?
          </summary>
          <div className="mt-2">
            <CopyCommand command="gh auth login" />
          </div>
        </details>
      </MethodCard>

      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Or connect another way
      </div>

      <MethodCard icon={<KeyIcon />} title="Git Credential Manager">
        <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          Use an HTTPS remote and let Git Credential Manager or your configured helper handle clone, fetch, pull, and
          push. Pull requests stay unavailable until you sign in with <code className="font-mono text-[12px]">gh</code>.
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          <button onClick={() => openExternalUrl(GCM_URL)} className={linkCls}>
            <ExternalIcon />
            Git Credential Manager
          </button>
          <button onClick={() => openExternalUrl("https://docs.github.com/get-started/git-basics/caching-your-github-credentials-in-git")} className={linkCls}>
            <ExternalIcon />
            GitHub credential docs
          </button>
        </div>
        <div className="mt-3">
          <CredentialEntryForm provider="github" helperOnly />
        </div>
      </MethodCard>

      <MethodCard icon={<LockIcon />} title="SSH key">
        <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          Add your public key to GitHub and use an SSH remote. Git authenticates with your key and ssh-agent; GitLane
          stores nothing. Pull requests still require <code className="font-mono text-[12px]">gh</code>.
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          <button onClick={() => openExternalUrl("https://github.com/settings/ssh/new")} className={linkCls}>
            <ExternalIcon />
            Add an SSH key on GitHub
          </button>
          <button onClick={() => openExternalUrl("https://docs.github.com/authentication/connecting-to-github-with-ssh")} className={linkCls}>
            <ExternalIcon />
            How to set up SSH keys
          </button>
        </div>
      </MethodCard>
    </div>
  );
}
