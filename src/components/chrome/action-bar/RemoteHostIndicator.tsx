import { cn } from "@/lib/cn";
import { openExternalUrl } from "@/lib/openExternal";
import { isRemoteLocator, remoteHost, remoteOrigin } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { connectionFor, remoteSessionOf, useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { serverLoginFixCommand, useServerLogin } from "@/hooks/useServerLogin";
import { useUi } from "@/store/ui";
import { ArrowUpRightIcon, ServerIcon } from "@/components/ui/icons";
import { ForgeIcon } from "@/components/chrome/forges";

const DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-400",
  installing: "bg-amber-400",
  disconnected: "bg-red-500",
  failed: "bg-red-500",
};

/** Toolbar chip for a repository opened over SSH (remote-ssh-repos): which
 * host it lives on, whether the session is up, and where its remote is
 * hosted. It takes the provider indicator's place: that one reports this
 * computer's accounts, which never apply here — the server's own login does. */
export const RemoteHostIndicator = ({ className }: { className?: string }) => {
  const path = useRepo((s) => s.summary?.path ?? null);
  const remote = !!path && isRemoteLocator(path);
  const session = useRemoteSessions(remoteSessionOf(remote ? remoteOrigin(path) : ""));
  const connection = useRemoteSessions(connectionFor(remote ? remoteOrigin(path) : ""));
  const forge = useRepo((s) => s.forge);
  const webUrl = forge?.webUrl;
  const serverLogin = useServerLogin();
  const expandTerminal = useUi((s) => s.expandTerminal);
  if (!remote) return null;
  const host = connection?.name ?? remoteHost(path);
  const state = session?.state ?? "connected";
  // The server's gh/glab can't serve pull requests yet: say what to run there,
  // one click from its terminal (remote/ssh-repos).
  const signInFix = serverLoginFixCommand(serverLogin);
  const signInTitle = !serverLogin?.provider || serverLogin.login
    ? null
    : signInFix
      ? `${host} is not signed in to ${forge?.forge ?? serverLogin.host}. Run \`${signInFix}\` in the terminal on ${host}.`
      : `${serverLogin.provider} on ${host} is missing or too old${serverLogin.requiredVersion ? ` (GitLane needs ${serverLogin.requiredVersion} or newer)` : ""}. Install or upgrade it there.`;
  return (
    <div
      role="status"
      title={`On ${host} over SSH (${state}). Git runs on the server with the server's own credentials and config. File editing, opening files on this computer and agents are off for remote repositories.`}
      className={cn(
        "flex h-8 flex-none items-center gap-1.5 rounded-lg border border-black/10 px-2 text-[12.5px] font-medium text-neutral-600 dark:border-white/10 dark:text-neutral-300",
        className,
      )}
    >
      <ServerIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />
      <span className="text-neutral-400 dark:text-neutral-500">SSH</span>
      <span className="max-w-40 truncate">{host}</span>
      <span aria-label={state} className={cn("h-1.5 w-1.5 rounded-full", DOT[state])} />
      {forge && webUrl && (
        <button
          type="button"
          onClick={() => openExternalUrl(webUrl)}
          title={`Open on ${forge.forge ?? forge.host}${serverLogin?.login ? ` · ${host} is signed in as ${serverLogin.login}` : ""}`}
          className={cn(
            "-mr-1 ml-1 flex items-center gap-1 rounded-md border-l border-black/10 py-0.5 pl-2 pr-1 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5",
            focusRing,
          )}
        >
          <ForgeIcon kind={forge.kind} className="h-3.5 w-3.5" />
          <span>{forge.forge ?? forge.host}</span>
          {serverLogin?.login && (
            <span className="max-w-32 truncate text-neutral-400 dark:text-neutral-500">as {serverLogin.login}</span>
          )}
          <ArrowUpRightIcon className="h-3 w-3 text-neutral-400" />
        </button>
      )}
      {signInTitle && (
        <button
          type="button"
          onClick={expandTerminal}
          title={signInTitle}
          className={cn(
            "ml-1 rounded-md px-1.5 py-0.5 text-amber-600 hover:bg-black/5 dark:text-amber-400 dark:hover:bg-white/5",
            focusRing,
          )}
        >
          Sign in
        </button>
      )}
    </div>
  );
};
