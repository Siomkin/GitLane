// Connect GitHub, one method at a time: a switch over GitHub CLI, Access token
// and SSH key, and the chosen method's panel alone. GitHub CLI opens first
// because it also powers pull requests; opened from "Fix authentication…" the
// Access token method does, with no terminal instructions, and a refused
// permission highlights Contents: Read and write. The choice is local state:
// which method fits depends on why the screen opened.

import { useState } from "react";
import type { AccountsConnectReason } from "@/store/ui";
import { MethodSwitch } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { CliMethod } from "./CliMethod";
import { GITHUB_METHODS, initialMethod } from "./methods";
import { SshMethod } from "./SshMethod";
import { TokenMethod } from "./TokenMethod";

export function GithubConnect({
  refresh,
  reason = null,
}: {
  refresh: React.ReactNode;
  /** Why the screen opened (a "Fix authentication…" toast), if it did. */
  reason?: AccountsConnectReason | null;
}) {
  const [method, setMethod] = useState(() => initialMethod(reason));
  const fromFailure = reason !== null;
  return (
    <div className="flex flex-col gap-4">
      <MethodSwitch value={method} options={GITHUB_METHODS} onChange={setMethod} />
      {method === "cli" && <CliMethod refresh={refresh} showTerminal={!fromFailure} />}
      {method === "token" && <TokenMethod autoFocus={fromFailure} highlightContents={reason === "permission"} />}
      {method === "ssh" && <SshMethod />}
    </div>
  );
}
