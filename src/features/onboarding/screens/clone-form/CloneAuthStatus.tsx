// The one-line auth status under a valid clone URL: how this clone will
// authenticate (from the same resolved plan startClone uses), with a quiet
// affordance to open the manual credential inputs. SSH URLs get key-setup
// link-outs instead — there is nothing to type for SSH.

import { useState } from "react";
import { openExternalUrl } from "../../../../lib/openExternal";
import { sshKeyHelp } from "../../../../lib/forgeHelp";
import { cloneProviderFor } from "../../flows/cloneAuth";
import type { OnboardingApi } from "../../flows/useOnboarding";
import { CloneAuthOptions } from "./CloneAuthOptions";

const linkCls =
  "font-semibold text-[color:var(--accent)] hover:underline";

export const CloneAuthStatus = ({ ob }: { ob: OnboardingApi }) => {
  const [open, setOpen] = useState(false);
  const plan = ob.cloneAuthPlan;

  if (plan.method === "ssh") {
    const help = sshKeyHelp(cloneProviderFor(ob.cloneRemoteInfo), ob.cloneRemoteInfo.host ?? "");
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-neutral-500 dark:text-neutral-400">
        <span>{ob.cloneAuthStatus}</span>
        {help.addUrl && (
          <button type="button" onClick={() => openExternalUrl(help.addUrl!)} className={linkCls}>
            Add an SSH key
          </button>
        )}
        {help.docsUrl && (
          <button type="button" onClick={() => openExternalUrl(help.docsUrl!)} className={linkCls}>
            How to set up SSH
          </button>
        )}
      </div>
    );
  }

  // A default plan with nothing resolved is the "public repo or set up later"
  // case — the affordance invites credentials; anything else offers to change.
  const nothingResolved = plan.method === "system" && !plan.login;
  return (
    <div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-neutral-500 dark:text-neutral-400">
        <span>{ob.cloneAuthStatus}</span>
        <button type="button" onClick={() => setOpen((v) => !v)} className={linkCls}>
          {open ? "Hide credentials" : nothingResolved ? "Add credentials…" : "Change…"}
        </button>
      </div>
      {open && <CloneAuthOptions ob={ob} />}
    </div>
  );
};
