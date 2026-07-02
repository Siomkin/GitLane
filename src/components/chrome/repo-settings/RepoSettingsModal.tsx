// Repository settings: a repo-scoped window (Identity · Remotes) split out of the
// global Settings modal. Reached from the toolbar provider indicator (hover
// "Repo settings" link + popover "In GitLane" group), never the title-bar gear.
// Identity is the per-repo *binding* panel (pick a profile / PR account); the
// profile and account libraries are managed in global Settings. Remotes is its
// own panel.

import { useRef } from "react";
import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { useDismiss } from "../../../hooks/useDismiss";
import { useUi } from "../../../store/ui";
import { useRepo } from "../../../store/repo";
import { IdentityPanel } from "../settings/identity-panel";
import { RepoSettingsSidebar } from "./RepoSettingsSidebar";
import { RemotesPanel } from "./remotes-panel";

const TITLE_ID = "repo-settings-title";

/** `owner/repo` from the remote web URL, else the working-directory leaf. */
const repoSlug = (webUrl: string | null | undefined, workdir: string | null | undefined): string => {
  if (webUrl) {
    const slug = webUrl.replace(/^https?:\/\/[^/]+\/?/, "").replace(/\.git$/, "");
    if (slug) return slug;
  }
  return workdir?.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "this repository";
};

export function RepoSettingsModal() {
  const open = useUi((s) => s.repoSettingsOpen);
  const section = useUi((s) => s.repoSettingsSection);
  const setSection = useUi((s) => s.setRepoSettingsSection);
  const close = useUi((s) => s.closeRepoSettings);
  const openGlobalSettings = useUi((s) => s.openSettings);
  const summary = useRepo((s) => s.summary);
  const forge = useRepo((s) => s.forge);

  // Suspend dismissal while a confirm/prompt (e.g. remove-remote) is open so its
  // Escape / backdrop doesn't also tear down this window.
  const overlayBlocking = useUi((s) => s.confirm !== null || s.prompt !== null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDismiss(open && !overlayBlocking, close, dialogRef);
  if (!open) return null;

  const repoName = repoSlug(forge?.webUrl, summary?.workdir);

  // The two windows are independent; the "App settings" link hands off to global.
  const goGlobal = () => {
    close();
    openGlobalSettings();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="flex h-[min(84vh,880px)] min-h-[420px] w-[min(88vw,1240px)] min-w-[640px] max-w-[94vw] overflow-hidden rounded-2xl border border-black/10 bg-neutral-100 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-900"
      >
        <h2 id={TITLE_ID} className="sr-only">
          Repository settings
        </h2>
        <RepoSettingsSidebar
          section={section}
          repoName={repoName}
          onSelect={setSection}
          onOpenGlobalSettings={goGlobal}
        />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            onClick={close}
            aria-label="Close repository settings"
            className={cn(
              "absolute right-5 top-5 z-10 grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-9 pb-10 pt-9">
            {section === "identity" && <IdentityPanel />}
            {section === "remotes" && <RemotesPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}
