import { useNotifications } from "@/store/notifications";

/** A step dialog that closes itself on success must not swallow a warning the
 *  delete reported (branch settings left behind): show it as a notification. */
export function notifyCaveat(warning: string | null): void {
  if (warning) useNotifications.getState().notify({ kind: "warning", title: warning });
}
