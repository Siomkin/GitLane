// GitHub is the only full-support path: browser device sign-in via `gh`, which
// then drives pull requests, push, and fetch. Kept distinct from the forge
// paths, which are auth-only.

import { cn } from "../../../../../lib/cn";
import { focusRing } from "../../../../../lib/ui";
import { openExternalUrl } from "../../../../../lib/openExternal";
import { useUi } from "../../../../../store/ui";
import { CopyCommand } from "../CopyCommand";
import { StateBlock, linkCls } from "./ui";

export function GithubConnect({ refresh }: { refresh: React.ReactNode }) {
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
