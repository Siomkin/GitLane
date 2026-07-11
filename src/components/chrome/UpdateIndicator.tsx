// Titlebar update affordance — an accent-tinted download glyph with a dot badge,
// shown only while an update is pending (offered / downloading / ready). Clicking
// it opens Settings → About, where the full software-update card lives. The
// look mirrors the Titlebar entry in the Claude Design project; state comes from
// the `useUpdates` store.

import { useUi } from "../../store/ui";
import { useUpdates, hasPendingUpdate } from "../../store/updates";
import { UpdateIcon } from "../ui/icons";

export const UpdateIndicator = () => {
  const status = useUpdates((s) => s.status);
  const newVersion = useUpdates((s) => s.newVersion);
  const pending = useUpdates(hasPendingUpdate);
  const openSettings = useUi((s) => s.openSettings);

  if (!pending) return null;

  const title =
    status === "ready"
      ? "Update ready — restart to install"
      : status === "downloading"
        ? "Downloading update…"
        : `Update available${newVersion ? ` (${newVersion})` : ""}`;

  return (
    <button type="button"
      onClick={() => openSettings("about")}
      title={title}
      aria-label={title}
      className="relative grid h-8 w-8 place-items-center rounded-lg text-[color:var(--accent)] hover:bg-[var(--accent-soft)]"
    >
      <UpdateIcon className="h-4 w-4" />
      <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[color:var(--accent)] ring-2 ring-neutral-100 dark:ring-neutral-900" />
    </button>
  );
};
