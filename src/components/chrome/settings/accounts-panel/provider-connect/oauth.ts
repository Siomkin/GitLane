// Native-OAuth constants + the small "is a client id registered?" probe that
// drives ordering (GL-139). GitLane can't ship one official OAuth app because
// users point at their own instances, so OAuth is opt-in per host: until a
// client id is registered the token/CLI paths lead and OAuth is demoted.

import { useEffect, useState } from "react";
import type { ForgeAuthProvider } from "@/lib/api";
import { useAccounts } from "@/store/accounts";

/** Providers GitLane can sign into with native OAuth. */
export const OAUTH_PROVIDERS = new Set<ForgeAuthProvider>(["gitlab", "bitbucket"]);

/** One field the user must set when registering the app, rendered as a checklist
 * row. `value` is the exact setting — these are the values whose absence produces
 * the opaque `invalid_client` / `invalid_scope` errors. */
export interface OauthSetting {
  label: string;
  value: string;
}

/** Provider-specific OAuth-app vocabulary + how to register one. Each forge names
 * the public client id differently (Bitbucket "Key", GitLab "Application ID") and
 * has its own must-set fields, so the UI uses the forge's own term, spells out the
 * exact settings to enter, and links to the place to create it. GitLane ships no
 * default app — a company registers its own and shares the public id. */
export interface OauthHelp {
  /** What the forge calls the app ("OAuth application" / "OAuth consumer"). */
  consumer: string;
  /** What the forge calls the public client id ("Application ID" / "Key"). */
  idTerm: string;
  /** Where in the forge UI to register it. */
  where: string;
  /** The exact fields to set — order matters, most error-prone first. */
  settings: OauthSetting[];
  /** A closing caveat (self-managed hosts, Cloud-only, which value to copy). */
  note: string;
  createLabel: string;
  createUrl: (host: string) => string;
}

export const OAUTH_HELP: Record<string, OauthHelp> = {
  gitlab: {
    consumer: "OAuth application",
    idTerm: "Application ID",
    where: "Settings → Applications → Add new application",
    settings: [
      {
        label: "Confidential",
        value: "off — GitLane is a public client and sends no secret",
      },
      { label: "Device authorization grant", value: "enabled" },
      { label: "Scopes", value: "read_repository, write_repository, read_user" },
      {
        label: "Redirect URI",
        value: "any value (required by the form, unused by the device flow)",
      },
    ],
    note: "Self-managed GitLab works too — set its host below. Each instance needs its own application.",
    createLabel: "Open GitLab → Applications",
    createUrl: (host) => `https://${host}/-/user_settings/applications`,
  },
  bitbucket: {
    consumer: "OAuth consumer",
    idTerm: "Key",
    where: "Workspace settings → OAuth consumers → Add consumer",
    settings: [
      { label: "Callback URL", value: "http://127.0.0.1/callback" },
      {
        label: "Permissions",
        value: "Account (read), Repositories (read and write), Pull requests (read and write)",
      },
      {
        label: "This is a private consumer",
        value: "leave unchecked — GitLane uses PKCE without a secret",
      },
    ],
    note: "Bitbucket Cloud only. Copy the consumer's Key — its Secret isn't needed.",
    createLabel: "How to create a Bitbucket OAuth consumer",
    createUrl: () => "https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/",
  },
};

export function isOauthProvider(provider: string): provider is ForgeAuthProvider {
  return OAUTH_PROVIDERS.has(provider as ForgeAuthProvider);
}

/** Whether a client id is registered for `provider` on its default host — the
 * signal ForgeConnect uses to decide whether OAuth leads. `null` while probing;
 * treated as "not configured" for ordering so the simpler token path leads until
 * proven otherwise. */
export function useOauthConfigured(provider: ForgeAuthProvider | null, host: string): boolean | null {
  const oauthClientStatus = useAccounts((s) => s.oauthClientStatus);
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!provider) {
      setConfigured(false);
      return;
    }
    let alive = true;
    setConfigured(null);
    Promise.resolve(oauthClientStatus(provider, host))
      .then((s) => {
        if (alive) setConfigured(Boolean(s?.configured));
      })
      .catch(() => {
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [provider, host, oauthClientStatus]);
  return configured;
}
