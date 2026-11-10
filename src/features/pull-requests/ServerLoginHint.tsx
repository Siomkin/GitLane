import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { serverLoginFixCommand, useServerLogin, useServerName } from "@/hooks/useServerLogin";
import { usePulls } from "@/store/pulls";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

const TOOL_NAME = { gh: "GitHub CLI (gh)", glab: "GitLab CLI (glab)" } as const;
const FORGE_NAME = { gh: "GitHub", glab: "GitLab" } as const;

const buttonClass = cn(
  "rounded-md border border-black/10 px-2 py-1 text-[11.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5",
  focusRing,
);

/** For a repository opened over SSH whose server can't serve pull requests:
 * what to fix on that server, with its terminal one click away
 * (remote/ssh-repos: "The server's forge login is shown with how to fix it").
 * GitLane never runs the sign-in or asks for a secret. Renders nothing when
 * the server is ready, or for a local repository. */
export function ServerLoginHint() {
  const login = useServerLogin();
  const path = useRepo((s) => s.summary?.path ?? "");
  const expandTerminal = useUi((s) => s.expandTerminal);
  const server = useServerName(path);
  if (!login?.provider || !login.host || !server) return null;
  const tool = TOOL_NAME[login.provider];
  const command = serverLoginFixCommand(login);
  let message: string;
  if (!login.installed) {
    message = `The ${tool} is not installed on ${server}. Install it there to use ${FORGE_NAME[login.provider]} pull requests.`;
  } else if (!login.supported) {
    const needs = login.requiredVersion ? ` GitLane needs ${login.requiredVersion} or newer.` : "";
    message = `The ${tool} on ${server} is too old.${needs} Upgrade it there.`;
  } else if (command) {
    message = `${server} is not signed in to ${FORGE_NAME[login.provider]} on ${login.host}. Run this in the terminal on ${server}:`;
  } else {
    return null;
  }
  const retry = async () => {
    await useRemoteSessions.getState().loadServerLogin(path);
    await usePulls.getState().loadPullRequests(true);
  };
  return (
    <div role="note" className="mx-2 my-2 space-y-2 rounded-lg border border-black/10 p-3 text-[11.5px] leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
      <p>{message}</p>
      {command && (
        <code className="block select-all rounded bg-black/5 px-2 py-1 font-mono text-[11px] text-neutral-700 dark:bg-white/5 dark:text-neutral-200">
          {command}
        </code>
      )}
      <div className="flex gap-1.5">
        <button type="button" className={buttonClass} onClick={expandTerminal}>
          Open terminal
        </button>
        <button type="button" className={buttonClass} onClick={() => void retry()}>
          Retry
        </button>
      </div>
    </div>
  );
}
