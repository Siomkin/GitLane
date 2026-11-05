// SSH key: Git authenticates with the user's key and ssh-agent, GitLane stores
// nothing. Two steps — add the key on GitHub, then point the remote at SSH in
// Repository settings › Remotes (GitLane does not rewrite the remote from here).

import { useState } from "react";
import { openExternalUrl } from "@/lib/openExternal";
import { sshKeyHelp } from "@/lib/forgeHelp";
import { openGithubRemote } from "@/store/accounts/credentialChecks";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import { MethodPanel, strongTextCls } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { githubCapabilities } from "./methods";

export function SshMethod() {
  const [remote] = useState(() => openGithubRemote());
  const host = remote?.host ?? "github.com";
  const { addUrl, docsUrl } = sshKeyHelp("github", host);
  // Placeholder, not the real path: the panel shows no repository names.
  const sshUrl = `git@${host}:owner/repo.git`;
  return (
    <MethodPanel
      capabilities={githubCapabilities("ssh")}
      title="SSH key"
      intro={`Git authenticates with a key on this computer and ssh-agent. GitLane stores nothing. The remote's address changes from https:// to git@${host}.`}
    >
      <ol className="flex list-decimal flex-col gap-1.5 pl-[18px] text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-300">
        <li>
          <span className={strongTextCls}>Add your public key on GitHub.</span>{" "}
          {addUrl && (
            <button type="button" onClick={() => openExternalUrl(addUrl)} className={linkCls}>
              Add an SSH key on GitHub ↗
            </button>
          )}
          {docsUrl && (
            <>
              {" · "}
              <button type="button" onClick={() => openExternalUrl(docsUrl)} className={linkCls}>
                No key yet? How to make one ↗
              </button>
            </>
          )}
        </li>
        <li>
          <span className={strongTextCls}>
            Switch {remote ? <span className="font-mono">{remote.name}</span> : "the remote"} to SSH.
          </span>{" "}
          In Repository settings › Remotes, change its address to <span className="font-mono">{sshUrl}</span>.
        </li>
      </ol>
    </MethodPanel>
  );
}
