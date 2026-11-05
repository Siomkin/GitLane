// Connect a non-GitHub provider, one method at a time: the provider's CLI where
// it has one, Access token for HTTPS (GitLane's keychain or the user's
// credential helper), and SSH key — the same switch and panels as Connect GitHub.

import { useState } from "react";
import { openExternalUrl } from "@/lib/openExternal";
import type { ForgeAuthStatus } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { linkCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import { MethodSwitch } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { CliMethod } from "./CliMethod";
import { ConnectedBanner } from "./ConnectedBanner";
import { forgeMethods, initialForgeMethod } from "./methods";
import { SshMethod } from "./SshMethod";
import { TokenMethod } from "./TokenMethod";

export function ForgeConnect({
  status,
  accountLoading,
  refresh,
}: {
  status: ForgeAuthStatus;
  accountLoading: boolean;
  refresh: React.ReactNode;
}) {
  const initial = initialForgeMethod(status);
  const [method, setMethod] = useState(initial);
  // Most-recent wins; the banner names the token's own host.
  const keychainToken =
    Object.values(useAccounts((s) => s.providerTokens))
      .filter((t) => t.provider === status.provider)
      .sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  // The default method is recommended until something is connected.
  const recommended = (m: typeof method) => m === initial && status.authenticated !== true && !keychainToken;

  return (
    <div className="flex flex-col gap-4">
      <ConnectedBanner status={status} keychainToken={keychainToken} resolving={accountLoading && !status.account} />
      <MethodSwitch value={method} options={forgeMethods(status)} onChange={setMethod} />
      {method === "cli" && <CliMethod status={status} recommended={recommended("cli")} />}
      {method === "token" && <TokenMethod status={status} recommended={recommended("token")} />}
      {method === "ssh" && <SshMethod status={status} />}
      <div className="flex items-center gap-3">
        {refresh}
        <button type="button" onClick={() => openExternalUrl(status.docsUrl)} className={linkCls}>
          Learn more
        </button>
      </div>
      {status.notes && <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">{status.notes}</p>}
    </div>
  );
}
