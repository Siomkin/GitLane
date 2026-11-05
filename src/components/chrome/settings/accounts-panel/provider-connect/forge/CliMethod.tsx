// The provider's own CLI (glab, az, origin, tea): signed in, not installed, or
// installed but not signed in — each state worded so none reads as a broken
// account.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import type { ForgeAuthStatus } from "@/lib/api";
import { prSupportedFor } from "@/components/chrome/settings/accounts-panel/providers";
import { CopyCommand } from "@/components/chrome/settings/accounts-panel/CopyCommand";
import { MethodPanel, mutedTextCls } from "@/components/chrome/settings/accounts-panel/provider-connect/methods";
import { forgeCapabilities } from "./methods";

function CliState({ status }: { status: ForgeAuthStatus }) {
  const cli = status.cli ?? "";
  if (status.authenticated) {
    return (
      <p className={mutedTextCls}>
        Signed in via <code className="font-mono text-[12px]">{cli}</code>
        {status.account?.username ? (
          <>
            {" "}
            as <span className="font-semibold">@{status.account.username}</span>
          </>
        ) : null}
        . This is the preferred path for provider features in GitLane.
      </p>
    );
  }
  if (!status.available) {
    return (
      <div>
        <p className={mutedTextCls}>
          The <code className="font-mono text-[12px]">{cli}</code> command-line tool isn’t installed yet — a setup step,
          not a broken account. Install it, then press Refresh.
        </p>
        <button
          type="button"
          onClick={() => openExternalUrl(status.docsUrl)}
          className={cn(
            "mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
            focusRing,
          )}
        >
          Install {cli}
        </button>
      </div>
    );
  }
  return (
    <div>
      <p className={mutedTextCls}>Run the login command in a terminal, then press Refresh.</p>
      <div className="mt-2.5">
        <CopyCommand command={status.loginCommand} />
      </div>
    </div>
  );
}

export function CliMethod({ status, recommended }: { status: ForgeAuthStatus; recommended: boolean }) {
  const cli = status.cli ?? "";
  return (
    <MethodPanel
      capabilities={forgeCapabilities(status, "cli")}
      title={status.authMethod}
      badge={recommended ? { label: "Recommended", accent: true } : undefined}
      intro={
        <>
          Sign in once with the <code className="font-mono">{cli}</code> command-line tool.{" "}
          {cli === "glab"
            ? `GitLane uses that sign-in for ${status.forge}${prSupportedFor(status.provider) ? ", including merge requests" : ""}.`
            : `GitLane uses it for ${status.forge}${prSupportedFor(status.provider) ? " pull requests" : ""}; fetch and push still use your Git credential helper or SSH.`}
        </>
      }
    >
      <CliState status={status} />
    </MethodPanel>
  );
}
