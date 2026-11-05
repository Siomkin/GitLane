// SSH key for a non-GitHub provider: Git authenticates with the user's key and
// ssh-agent, GitLane stores nothing. Links out to the provider's key pages.

import { openExternalUrl } from "@/lib/openExternal";
import type { ForgeAuthStatus } from "@/lib/api";
import { DEFAULT_CREDENTIAL_HOST, sshKeyHelp } from "@/lib/forgeHelp";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import { MethodPanel } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { forgeCapabilities } from "./methods";

export function SshMethod({ status }: { status: ForgeAuthStatus }) {
  const host = DEFAULT_CREDENTIAL_HOST[status.provider] ?? "";
  const { addUrl, docsUrl } = sshKeyHelp(status.provider, host);
  return (
    <MethodPanel
      capabilities={forgeCapabilities(status, "ssh")}
      title="SSH key"
      intro={
        <>
          Add your public key to {status.forge} and an <span className="font-mono">ssh://</span> remote authenticates
          with your key and ssh-agent — no token, and GitLane stores nothing.
        </>
      }
    >
      {(addUrl || docsUrl) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {addUrl && (
            <button type="button" onClick={() => openExternalUrl(addUrl)} className={linkCls}>
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              Add an SSH key on {status.forge}
            </button>
          )}
          {docsUrl && (
            <button type="button" onClick={() => openExternalUrl(docsUrl)} className={linkCls}>
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              How to set up SSH keys
            </button>
          )}
        </div>
      )}
    </MethodPanel>
  );
}
