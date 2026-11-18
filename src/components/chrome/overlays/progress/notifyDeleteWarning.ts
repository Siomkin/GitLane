import type { BranchDeleteOutcome } from "@/lib/api";
import { useNotifications } from "@/store/notifications";

/** A delete dialog that closes itself on success must not swallow a warning the
 *  delete reported (branch settings left behind): name what was deleted in the
 *  title and put the warning, with git's own error text, in the body. */
export function notifyDeleteWarning({ message, warning }: BranchDeleteOutcome): void {
  if (warning) useNotifications.getState().notify({ kind: "warning", title: message, body: warning });
}
