// Access token for a non-GitHub provider: its token page (GitLab's on the
// remote's own host) or its docs, suggested settings in generic words (no
// repository names), and GitLane's keychain form where GitLane can own the
// token (GitLab, Bitbucket) beside the credential-helper form.

import { useState } from "react";
import { openExternalUrl } from "@/lib/openExternal";
import type { ForgeAuthStatus } from "@/lib/api";
import { DEFAULT_CREDENTIAL_HOST, supportsProviderTokenAuth, tokenHelp } from "@/lib/forgeHelp";
import { openProviderRemote } from "@/store/accounts/credentialChecks";
import { KeychainTokenForm } from "@/components/chrome/settings/accounts-panel/provider-connect/KeychainTokenForm";
import { CredentialEntryForm } from "@/components/chrome/settings/accounts-panel/provider-connect/credential-entry";
import {
  AccessTokenMethod,
  linkButtonCls,
  mono,
  mutedTextCls,
  Setting,
} from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { forgeCapabilities } from "./methods";

const SUGGESTIONS = "Suggestions, not requirements: choose what fits how you work.";

function Needs({ status }: { status: ForgeAuthStatus }) {
  if (status.provider === "gitlab") {
    return (
      <>
        <p className={mutedTextCls}>{SUGGESTIONS}</p>
        <Setting name={mono("read_repository")}>To fetch and pull.</Setting>
        <Setting name={mono("write_repository")}>To push.</Setting>
        <Setting name={mono("api")}>
          Only if you want merge requests in GitLane without GitLab CLI. It is much broader than the two above.
        </Setting>
      </>
    );
  }
  if (status.provider === "bitbucket") {
    return (
      <>
        <p className={mutedTextCls}>
          {SUGGESTIONS} Bitbucket takes an API token with scopes, created in your Atlassian account.
        </p>
        <Setting name="Repositories">Read access to fetch and pull; write access to push.</Setting>
        <Setting name="Pull requests">Only if you want pull requests in GitLane.</Setting>
        <Setting name="Username">
          With an API token Git sends {mono("x-bitbucket-api-token-auth")}, which GitLane fills in.
        </Setting>
      </>
    );
  }
  return (
    <p className={mutedTextCls}>
      {SUGGESTIONS} Read and write access to repositories: read to fetch and pull, write to push. {status.forge}'s docs
      name the exact settings.
    </p>
  );
}

export function TokenMethod({ status, recommended }: { status: ForgeAuthStatus; recommended: boolean }) {
  const keychainSupported = supportsProviderTokenAuth(status.provider);
  const [host, setHost] = useState(
    () => openProviderRemote(status.provider)?.credentialHost ?? DEFAULT_CREDENTIAL_HOST[status.provider] ?? "",
  );
  const { createUrl } = tokenHelp(status.provider, host);

  return (
    <AccessTokenMethod
      forge={status.forge}
      keychainSupported={keychainSupported}
      capabilities={(storage) => forgeCapabilities(status, "token", storage)}
      badge={recommended ? { label: "Recommended", accent: true } : undefined}
      createLinks={
        <div className="flex flex-wrap gap-2">
          {createUrl ? (
            <button type="button" onClick={() => openExternalUrl(createUrl)} className={linkButtonCls}>
              Personal access tokens ↗
            </button>
          ) : (
            <button type="button" onClick={() => openExternalUrl(status.docsUrl)} className={linkButtonCls}>
              {status.forge} token docs ↗
            </button>
          )}
        </div>
      }
      needs={<Needs status={status} />}
      keychainForm={
        keychainSupported ? <KeychainTokenForm provider={status.provider} onHostChange={setHost} /> : undefined
      }
      helperForm={<CredentialEntryForm provider={status.provider} usernameHint={status.account?.username} />}
      helperExtra={
        status.provider === "bitbucket" && (
          <p className="text-[11.5px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            Bitbucket documents GCM as an HTTPS alternative to SSH. Use an HTTPS URL such as{" "}
            <code className="font-mono">https://username@bitbucket.org/workspace/repo.git</code>.
          </p>
        )
      }
    />
  );
}
