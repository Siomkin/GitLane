import { useNotifications } from "@/store/notifications";

/** A step dialog that closes itself on success must not swallow a caveat the
 *  backend appended to its success text (", but its local branch settings could
 *  not be removed: …"): show anything beyond `routine` as a warning. Returns
 *  whether it notified. */
// shortcut: detects the caveat by comparing with the routine success text; if
// the Rust wording starts to vary, send a structured `warning` field over IPC.
export function notifyCaveat(message: string, routine: string): boolean {
  if (!message || message === routine) return false;
  useNotifications.getState().notify({ kind: "warning", title: message });
  return true;
}
