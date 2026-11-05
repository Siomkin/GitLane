// What a credential save in Settings reports back to its form, and the
// post-save check that the open repository's remotes accept the credential.
// The forms render these outcomes inline: Settings is a modal, so a toast would
// sit underneath it.

import { api, isCommandError, type GitTransportAuthRef, type GitTransportProvider } from "@/lib/api";
import { friendlyGitError } from "@/lib/gitError";
import { isRemoteLocator } from "@/lib/paths";
import { detectRemoteUrl } from "@/lib/remotes";
import { storeLinks } from "@/store/links";

/** One remote's answer to the post-save `ls-remote` check. */
export type RemoteCheck =
  | { remote: string; ok: true }
  | { remote: string; ok: false; message: string; kind: string; code?: string | null; detail: string | null };

export type CredentialSaveOutcome =
  | {
      ok: true;
      /** Remotes of the open repo on this host that were checked; empty when
       * there was nothing to check (no repo open, or none on this host). */
      checks: RemoteCheck[];
      /** A note to show beside the success, e.g. the username spelling used. */
      note: string | null;
    }
  | {
      ok: false;
      message: string;
      /** `credentialShadowed`: the username a helper returned instead, which
       * the form offers to forget. */
      shadowedUsername: string | null;
      /** The OS keychain could not store the token (Linux without a Secret
       * Service, …); the form offers the credential-helper fallback. */
      keychainUnavailable: boolean;
      /** The backend reported that no Git credential helper is configured. */
      noCredentialHelper: boolean;
      /** Git's own (backend-redacted) output, when it says more than `message`. */
      detail?: string | null;
    };

/** Git's own output behind a friendly message — already secret-redacted by the
 * backend — or null when there is none or it adds nothing. */
export function gitDetail(error: unknown, message: string): string | null {
  const raw = isCommandError(error) ? error.message.trim() : "";
  return raw && raw !== message.trim() ? raw : null;
}

/** A failed outcome from a caught rejection or a local validation message. */
export function failedOutcome(error: unknown): Extract<CredentialSaveOutcome, { ok: false }> {
  const command = isCommandError(error) ? error : null;
  const message = typeof error === "string" ? error : friendlyGitError(error);
  return {
    ok: false,
    message,
    detail: gitDetail(error, message),
    shadowedUsername: command?.code === "credentialShadowed" ? (command.credentialUsername ?? null) : null,
    keychainUnavailable: command?.code === "keychain",
    noCredentialHelper: command?.code === "noCredentialHelper",
  };
}

const sameHost = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One HTTPS remote of the open local repository, as a check needs it. */
export interface OpenHttpsRemote {
  path: string;
  name: string;
  host: string;
  credentialHost: string;
  user: string | null;
  provider: string;
}

/** The open local repository's HTTPS remotes (by fetch URL). */
function openHttpsRemotes(): OpenHttpsRemote[] {
  const { summary, remotes } = storeLinks.openRepo();
  if (!summary || isRemoteLocator(summary.path)) return [];
  return remotes.flatMap((remote) => {
    const info = detectRemoteUrl(remote.fetchUrl);
    if (!info.valid || info.ssh || !info.host || !info.credentialHost) return [];
    return [
      {
        path: summary.path,
        name: remote.name,
        host: info.host,
        credentialHost: info.credentialHost,
        user: info.user ?? null,
        provider: info.provider,
      },
    ];
  });
}

/** The open repo's HTTPS remotes whose fetch URL uses `credentialHost`. */
export function openRemotesOnHost(credentialHost: string): OpenHttpsRemote[] {
  return openHttpsRemotes().filter((r) => sameHost(r.credentialHost, credentialHost));
}

/** The open repo's first HTTPS remote classified as `provider` (`detectRemoteUrl`'s
 * word, e.g. `github` for github.com or an Enterprise Server), which that
 * provider's token form targets by default. */
export const openProviderRemote = (provider: string): OpenHttpsRemote | undefined =>
  openHttpsRemotes().find((r) => r.provider === provider);

export const openGithubRemote = (): OpenHttpsRemote | undefined => openProviderRemote("github");

/** A check ref for the GitLane token just stored, so the check exercises that
 * token — not whatever a fetch would otherwise pick (a gh binding, an older
 * token keyed by the URL's spelling). */
export const providerTokenCheckRef =
  (provider: GitTransportProvider, username: string, accountId: string) =>
  (r: OpenHttpsRemote): GitTransportAuthRef => ({
    mode: "providerToken",
    provider,
    host: r.host,
    credentialHost: r.credentialHost,
    username,
    providerAccountId: accountId,
  });

/** A check ref for the user's credential helper, so a helper save is checked
 * through the helper even where a fetch would use gh or a GitLane token.
 * Keeps a path-scoped (`useHttpPath`) helper ref when transport resolves one. */
export const helperCheckRef =
  (resolved: (remote: string) => GitTransportAuthRef | null) =>
  (r: OpenHttpsRemote): GitTransportAuthRef => {
    const ref = resolved(r.name);
    if (ref?.mode === "credentialHelper") return ref;
    return {
      mode: "credentialHelper",
      host: r.host,
      credentialHost: r.credentialHost,
      username: r.user,
      ...(r.provider === "azure" ? { useHttpPath: true } : {}),
    };
  };

/** The one spelling the open repo's remotes on this host use for `username`
 * when it differs from the typed one only in case; `null` otherwise. Git
 * matches saved credentials by exact username, so the helper save uses the
 * URL's spelling. Two remotes that disagree leave the typed value alone. */
export function remoteSpellingFor(credentialHost: string, username: string): string | null {
  const spellings = new Set(
    openRemotesOnHost(credentialHost)
      .map((r) => r.user)
      .filter((user): user is string => !!user && user !== username && user.toLowerCase() === username.toLowerCase()),
  );
  return spellings.size === 1 ? [...spellings][0] : null;
}

/** Check `remotes` (default: every open remote on `credentialHost`) with the
 * ref `refFor` builds for the credential just saved. */
export async function checkHostRemotes(
  credentialHost: string,
  refFor: (remote: OpenHttpsRemote) => GitTransportAuthRef,
  only?: string,
): Promise<RemoteCheck[]> {
  const remotes = openRemotesOnHost(credentialHost).filter((r) => only === undefined || r.name === only);
  return Promise.all(
    remotes.map(async (remote): Promise<RemoteCheck> => {
      try {
        await api.checkRemoteAccess(remote.path, remote.name, refFor(remote));
        return { remote: remote.name, ok: true };
      } catch (e) {
        // Generic retry wording: the user is already in the credential form.
        const message = friendlyGitError(e, { credentialHelp: "generic" });
        return {
          remote: remote.name,
          ok: false,
          message,
          kind: isCommandError(e) ? e.kind : "internal",
          code: isCommandError(e) ? (e.code ?? null) : null,
          detail: gitDetail(e, message),
        };
      }
    }),
  );
}

/** Every checked remote refused the credential as an auth failure. */
export const everyCheckRejected = (checks: RemoteCheck[]): boolean =>
  checks.length > 0 && checks.every((c) => !c.ok && c.kind === "auth");
