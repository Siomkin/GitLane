// GitHub's Access token: its fine-grained and classic token pages, the
// suggested settings (the user decides; no repository or owner names are
// shown), and either GitLane's keychain form or the credential-helper form.
// The links follow the host being saved for, so an Enterprise Server gets its
// own pages.

import { useState } from "react";
import { openExternalUrl } from "@/lib/openExternal";
import { tokenHelp } from "@/lib/forgeHelp";
import { openGithubRemote } from "@/store/accounts/credentialChecks";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { KeychainTokenForm } from "@/components/chrome/settings/accounts-panel/provider-connect/KeychainTokenForm";
import { CredentialEntryForm } from "@/components/chrome/settings/accounts-panel/provider-connect/credential-entry";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import {
  AccessTokenMethod,
  linkButtonCls,
  mono,
  mutedTextCls,
  sectionLabelCls,
  Setting,
} from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { githubCapabilities } from "./methods";

const CREDENTIAL_DOCS_URL = "https://docs.github.com/get-started/git-basics/caching-your-github-credentials-in-git";
const cardCls = "flex flex-col gap-2 rounded-[10px] border border-black/[0.08] p-3 dark:border-white/[0.1]";

function Needs({ highlightContents }: { highlightContents: boolean }) {
  return (
    <>
      <p className={mutedTextCls}>
        Suggestions, not requirements: choose what fits how you work. GitLane only needs access to the repositories you
        open here.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className={cardCls}>
          <span className={sectionLabelCls}>Fine-grained</span>
          <Setting name="Resource owner">
            The account or organization that owns the repositories you'll use. An organization may need an admin to
            approve the token.
          </Setting>
          <Setting name="Repository access">
            Any choice that includes those repositories. All repositories is simplest; selecting only some keeps the
            token narrower.
          </Setting>
          <Setting name="Permissions › Contents" highlight={highlightContents}>
            Read and write if you want to push; Read only is enough to fetch and pull. Metadata: Read is added for you.
          </Setting>
        </div>
        <div className={cardCls}>
          <span className={sectionLabelCls}>Classic</span>
          <Setting name="Scope">
            {mono("repo")} gives access to every repository your account can reach. Simpler, but broader than a
            fine-grained token.
          </Setting>
          <Setting name={<>Add <span className="font-mono">workflow</span></>}>
            If you push changes to {mono(".github/workflows")}.
          </Setting>
          <Setting name="Expiration">
            Your choice. When it expires, Git stops authenticating and GitLane asks for a new one.
          </Setting>
        </div>
      </div>
    </>
  );
}

export function TokenMethod({
  highlightContents = false,
  autoFocus = false,
}: {
  /** Opened from a refused permission: Contents: Read and write is the fix. */
  highlightContents?: boolean;
  autoFocus?: boolean;
}) {
  const [host, setHost] = useState(() => openGithubRemote()?.credentialHost ?? "github.com");
  const { fineGrainedUrl, classicUrl } = tokenHelp("github", host);

  return (
    <AccessTokenMethod
      forge="GitHub"
      keychainSupported
      capabilities={(storage) => githubCapabilities("token", storage)}
      createLinks={
        <div className="flex flex-wrap gap-2">
          {fineGrainedUrl && (
            <button type="button" onClick={() => openExternalUrl(fineGrainedUrl)} className={linkButtonCls}>
              Fine-grained token (recommended) ↗
            </button>
          )}
          {classicUrl && (
            <button type="button" onClick={() => openExternalUrl(classicUrl)} className={linkButtonCls}>
              Classic token ↗
            </button>
          )}
        </div>
      }
      needs={<Needs highlightContents={highlightContents} />}
      keychainForm={<KeychainTokenForm autoFocus={autoFocus} onHostChange={setHost} />}
      helperForm={<CredentialEntryForm provider="github" />}
      helperExtra={
        <button type="button" onClick={() => openExternalUrl(CREDENTIAL_DOCS_URL)} className={linkCls}>
          <ExternalLinkIcon className="h-3.5 w-3.5" />
          GitHub credential docs
        </button>
      }
    />
  );
}
