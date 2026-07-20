// Pure view-model for the clone-failure recovery panel: everything the panel
// needs to offer the right fix for the attempted URL — which provider it is,
// the credential-helper/GCM context, and the SSH key pages for ssh remotes. No
// React, no IPC.

import type { ForgeAuthProvider } from "@/lib/api";
import { sshKeyHelp, type SshKeyHelp } from "@/lib/forgeHelp";
import { detectRemoteUrl, forgeAuthProviderFor, providerLabel } from "@/lib/remotes";
import { cloneProviderFor } from "./flows/cloneAuth";

export interface AuthRecovery {
  /** SSH remote → key guidance instead of credential-helper/GCM guidance. */
  ssh: boolean;
  /** Provider whose Accounts connect view fixes this, or null (unknown host). */
  providerKey: "github" | ForgeAuthProvider | null;
  /** Human forge name ("GitLab", "Bitbucket", …). */
  forgeLabel: string;
  host: string | null;
  credentialHost: string | null;
  sshHelp: SshKeyHelp;
  /** The same repo over SSH (`git@host:path.git`) when the attempt was HTTPS —
   * the "prefer SSH?" switch. Null for SSH attempts and for Azure, whose SSH
   * URLs use a different shape than its HTTPS path. */
  sshUrl: string | null;
  /** The same repo over HTTPS when the attempt was SSH — the "no key? use a
   * credential-helper/GCM" switch. */
  httpsUrl: string | null;
}

function recoveryUrls(host: string, path: string): { ssh: string; https: string } {
  const ipv6 = host.includes(":");
  const authority = ipv6 ? `[${host}]` : host;
  return {
    // SCP syntax cannot represent a colon-bearing IPv6 hostname
    // unambiguously, so use the URI form for that one case.
    ssh: ipv6 ? `ssh://git@${authority}/${path}.git` : `git@${host}:${path}.git`,
    https: `https://${authority}/${path}.git`,
  };
}

export function buildAuthRecovery(attemptedUrl: string): AuthRecovery {
  const info = detectRemoteUrl(attemptedUrl);
  const provider = cloneProviderFor(info);
  const providerKey =
    info.provider === "github" ? "github" : forgeAuthProviderFor(info.provider);
  // Cross-transport switches. Azure is excluded from the SSH form: its scp-style
  // URL is ssh://git@ssh.dev.azure.com/v3/…, not derivable from the HTTPS path.
  const convertible = info.valid && !!info.host && !!info.path && info.provider !== "azure";
  const alternatives = convertible ? recoveryUrls(info.host!, info.path!) : null;

  return {
    ssh: info.ssh,
    providerKey,
    forgeLabel: providerLabel(info.provider),
    host: info.host,
    credentialHost: info.credentialHost,
    sshHelp: sshKeyHelp(provider, info.host ?? ""),
    sshUrl: !info.ssh ? alternatives?.ssh ?? null : null,
    // An explicit ssh:// port belongs to the SSH daemon, not the forge's HTTPS
    // endpoint. Convert with the classified bare host while still retaining the
    // original authority in `credentialHost` for diagnostics.
    httpsUrl: info.ssh ? alternatives?.https ?? null : null,
  };
}
