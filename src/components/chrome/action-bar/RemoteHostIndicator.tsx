import { cn } from "@/lib/cn";
import { isRemoteLocator, remoteHost, remoteOrigin } from "@/lib/paths";
import { remoteSessionOf, useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { ServerIcon } from "@/components/ui/icons";

const DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-400",
  installing: "bg-amber-400",
  disconnected: "bg-red-500",
  failed: "bg-red-500",
};

/** Toolbar chip for a repository opened over SSH (remote-ssh-repos): which
 * host it lives on and whether the session is up. It takes the hosting
 * provider indicator's place, since pull requests are off for these. */
export const RemoteHostIndicator = ({ className }: { className?: string }) => {
  const path = useRepo((s) => s.summary?.path ?? null);
  const remote = !!path && isRemoteLocator(path);
  const session = useRemoteSessions(remoteSessionOf(remote ? remoteOrigin(path) : ""));
  if (!remote) return null;
  const host = remoteHost(path);
  const state = session?.state ?? "connected";
  return (
    <div
      role="status"
      title={`On ${host} over SSH (${state}). Git runs on the server with the server's own credentials and config. Pull requests, the terminal, file editing and agents are off for remote repositories.`}
      className={cn(
        "flex h-8 flex-none items-center gap-1.5 rounded-lg border border-black/10 px-2 text-[12.5px] font-medium text-neutral-600 dark:border-white/10 dark:text-neutral-300",
        className,
      )}
    >
      <ServerIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />
      <span className="text-neutral-400 dark:text-neutral-500">SSH</span>
      <span className="max-w-40 truncate">{host}</span>
      <span aria-label={state} className={cn("h-1.5 w-1.5 rounded-full", DOT[state])} />
    </div>
  );
};
