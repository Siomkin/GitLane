// GitHub CLI: the recommended method, since the `gh` account powers pull
// requests as well as git transport. Sign in with a one-time device code; the
// terminal alternative is hidden when the screen opened from a failure.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import { openGithubRemote } from "@/store/accounts/credentialChecks";
import { useUi } from "@/store/ui";
import { CopyCommand } from "@/components/chrome/settings/accounts-panel/CopyCommand";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import { MethodPanel, sectionLabelCls } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { githubCapabilities } from "./methods";

export function CliMethod({ refresh, showTerminal }: { refresh: React.ReactNode; showTerminal: boolean }) {
  const openGithubSignin = useUi((s) => s.openGithubSignin);
  const [remoteName] = useState(() => openGithubRemote()?.name ?? null);
  return (
    <MethodPanel
      capabilities={githubCapabilities("cli")}
      title="GitHub CLI"
      badge={{ label: "Recommended", accent: true }}
      intro="Sign in once in your browser with a one-time code. GitLane uses that account for pull requests and for clone, fetch, pull and push."
    >
      <div className="flex flex-col gap-1.5">
        <span className={sectionLabelCls}>What happens</span>
        <ol className="flex list-decimal flex-col gap-1 pl-[18px] text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
          <li>GitLane shows a one-time code and opens github.com/login/device.</li>
          <li>You approve GitLane there with the account that owns or can push to this repository.</li>
          <li>
            The account appears under Accounts; pick it for{" "}
            {remoteName ? <span className="font-mono">{remoteName}</span> : "your remote"} in Repository settings ›
            Remotes.
          </li>
        </ol>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => openGithubSignin("github.com")}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
            focusRing,
          )}
        >
          Sign in with GitHub
        </button>
        {refresh}
        <button type="button" onClick={() => openExternalUrl("https://cli.github.com")} className={cn(linkCls, "px-1")}>
          GitHub CLI isn't installed — get it
        </button>
      </div>
      {showTerminal && (
        <details className="text-[12px] text-neutral-500 dark:text-neutral-400">
          <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200">
            Prefer the terminal?
          </summary>
          <div className="mt-2">
            <CopyCommand command="gh auth login" />
          </div>
        </details>
      )}
    </MethodPanel>
  );
}
