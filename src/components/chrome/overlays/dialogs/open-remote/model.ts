// Pure helpers for the open-remote dialog (remote-ssh-repos): the host form's
// validation, building and splitting `ssh://[user@]host[:port]` origins, and
// the folder browser's path steps. No React, no IPC.

import { isRemoteLocator, REMOTE_LOCATOR_PREFIX, remoteOrigin } from "@/lib/paths";

/** The host form: what the user types, before it becomes an origin. */
export interface HostFields {
  host: string;
  user: string;
  port: string;
}

export const EMPTY_HOST: HostFields = { host: "", user: "", port: "" };

// `ssh` reads a leading `-` as an option; `@`, `:` and `/` belong to the
// origin's own syntax, so each field refuses them.
const WORD = /^[^\s@:/-][^\s@:/]*$/;

/** Why the fields can't be used, or null. Empty optional fields are fine. */
export function hostFieldsProblem({ host, user, port }: HostFields): string | null {
  if (host && !WORD.test(host)) return "Enter a host name, IP address or SSH config alias.";
  if (user && !WORD.test(user)) return "Enter a user name without spaces, @ or :.";
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))
    return "Enter a port between 1 and 65535.";
  return null;
}

/** `ssh://[user@]host[:port]` from the fields (trimmed). */
export function originOf({ host, user, port }: HostFields): string {
  const u = user.trim();
  const p = port.trim();
  return `${REMOTE_LOCATOR_PREFIX}${u ? `${u}@` : ""}${host.trim()}${p ? `:${p}` : ""}`;
}

/** The fields an origin was built from — the inverse of {@link originOf}. */
export function fieldsOf(origin: string): HostFields {
  const authority = origin.slice(REMOTE_LOCATOR_PREFIX.length);
  const at = authority.lastIndexOf("@");
  const user = at === -1 ? "" : authority.slice(0, at);
  const hostPort = authority.slice(at + 1);
  const port = hostPort.match(/:(\d+)$/)?.[1] ?? "";
  return { host: port ? hostPort.slice(0, -port.length - 1) : hostPort, user, port };
}

/** Origins of previously opened remote repositories, most recent first, once
 * each — the dialog's "recent hosts". */
export function recentOrigins(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isRemoteLocator).map(remoteOrigin))];
}

/** Why a typed server path can't be opened, or null: it must be absolute. */
export function pathProblem(path: string): string | null {
  if (!path) return null;
  if (!path.startsWith("/") || path.startsWith("/~"))
    return "Enter an absolute path on the server (starting with /, without ~).";
  return null;
}

/** `dir`'s parent, stopping at `/`. */
export function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

/** `name` inside `dir`. */
export function childOf(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Breadcrumb steps for `dir`: `/`, then each ancestor down to `dir`. */
export function crumbsOf(dir: string): { label: string; path: string }[] {
  const parts = dir.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...parts.map((label, i) => ({ label, path: `/${parts.slice(0, i + 1).join("/")}` })),
  ];
}
