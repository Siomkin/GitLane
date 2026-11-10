import { useEffect } from "react";
import type { ForgeServerLogin } from "@/lib/api";
import { isRemoteLocator, remoteHost, remoteOrigin } from "@/lib/paths";
import { connectionFor, remoteSessionOf, serverLoginOf, useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";

/** For a repository opened over SSH: the server's forge CLI login its pull
 * requests run as (remote/ssh-repos), asked once each time its host connects.
 * `undefined` for a local repository, or until the server answers. */
export function useServerLogin(): ForgeServerLogin | undefined {
  const path = useRepo((s) => s.summary?.path ?? null);
  const remotePath = path && isRemoteLocator(path) ? path : "";
  const connected = useRemoteSessions(
    (s) => !!remotePath && (remoteSessionOf(remoteOrigin(remotePath))(s)?.state ?? "connected") === "connected",
  );
  const login = useRemoteSessions(serverLoginOf(remotePath));
  useEffect(() => {
    if (remotePath && connected) void useRemoteSessions.getState().loadServerLogin(remotePath);
  }, [remotePath, connected]);
  return remotePath ? login : undefined;
}

/** What to run on the server so its forge CLI can serve pull requests, or
 * `null` when it already can. */
const PLAIN_HOST = /^[A-Za-z0-9.-]+$/;

export function serverLoginFixCommand(login: ForgeServerLogin | undefined): string | null {
  if (!login?.provider || !login.host || !login.installed || !login.supported || login.login) return null;
  // The host comes from the server's remote config and lands in a command to copy.
  if (!PLAIN_HOST.test(login.host)) return null;
  return `${login.provider} auth login --hostname ${login.host}`;
}

/** Who a pull-request write runs as on a repository opened over SSH: the
 * server and its login, or why writes are off until the server signs in.
 * `login` is `null` only once the server answered with no login (writes are
 * then off), `undefined` while unknown. `null` for a local repository, where
 * this computer's account applies. */
export function useRemotePrWriter(): { server: string; login: string | null | undefined; label: string } | null {
  const path = useRepo((s) => s.summary?.path ?? null);
  const login = useServerLogin();
  const server = useServerName(path);
  if (!path || !isRemoteLocator(path) || !server) return null;
  const who = login?.login;
  return {
    server,
    login: who,
    label: who
      ? `Runs on ${server} as ${who}`
      : who === null
        ? `Sign in on ${server} to change pull requests`
        : `Runs on ${server} with its own login`,
  };
}

/** What the UI calls a remote repository's server: its saved connection's
 * name, as the SSH chip shows it, else the locator's host. */
export function useServerName(path: string | null): string | null {
  const remote = !!path && isRemoteLocator(path);
  const name = useRemoteSessions((s) => (remote ? connectionFor(remoteOrigin(path))(s)?.name : undefined));
  return remote ? (name ?? remoteHost(path)) : null;
}
