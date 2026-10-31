// Pure helpers for the open-remote dialog and the SSH connections settings
// (remote-ssh-repos): the connection form's validation and conversion, and
// the folder browser's path steps. No React, no IPC.

import type { SshConnection } from "@/lib/api";

/** The connection form as typed (remote-ssh-repos D11): `host` may carry a
 * user as `user@host`, like ssh's own destination. */
export interface ConnectionForm {
  name: string;
  host: string;
  port: string;
  identityFile: string;
}

export const EMPTY_FORM: ConnectionForm = { name: "", host: "", port: "", identityFile: "" };

// `ssh` reads a leading `-` as an option; `@`, `:` and `/` belong to the
// origin's own syntax.
const WORD = /^[^\s@:/-][^\s@:/]*$/;

/** `user@host` split at its last `@`. */
export function splitDestination(destination: string): { user: string | null; host: string } {
  const value = destination.trim();
  const at = value.lastIndexOf("@");
  return at === -1 ? { user: null, host: value } : { user: value.slice(0, at), host: value.slice(at + 1) };
}

/** Why the form can't be saved or tested, or null. The backend checks again. */
export function formProblem(form: ConnectionForm, { needName }: { needName: boolean }): string | null {
  const { user, host } = splitDestination(form.host);
  if (needName && !form.name.trim()) return "Give the connection a name.";
  if (!host) return "Enter a host: user@server, an address, or an alias from ~/.ssh/config.";
  if (!WORD.test(host) || (user !== null && !WORD.test(user)))
    return "Enter the host as user@server, an address, or an SSH config alias.";
  const port = form.port.trim();
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535))
    return "Enter a port between 1 and 65535.";
  const key = form.identityFile.trim();
  if (key && (key.startsWith("-") || !(key.startsWith("/") || key.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(key))))
    return "Enter the key file's full path, or one starting with ~/.";
  return null;
}

/** The saved-connection shape of a valid form. */
export function connectionOf(form: ConnectionForm): SshConnection {
  const { user, host } = splitDestination(form.host);
  return {
    name: form.name.trim(),
    host,
    user,
    port: form.port.trim() ? Number(form.port.trim()) : null,
    identityFile: form.identityFile.trim() || null,
  };
}

/** The form showing `connection`, for editing. */
export function formOf(connection: SshConnection): ConnectionForm {
  return {
    name: connection.name,
    host: connection.user ? `${connection.user}@${connection.host}` : connection.host,
    port: connection.port ? String(connection.port) : "",
    identityFile: connection.identityFile ?? "",
  };
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
