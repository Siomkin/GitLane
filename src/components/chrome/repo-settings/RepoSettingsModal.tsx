// Repository settings: a repo-scoped window split out of the global Settings
// modal, reached from the toolbar provider indicator. The content is ONE page
// (GL-130): commit identity on top, remotes — with their per-remote account
// pickers — right below, because the two picks belong together ("who authors"
// directly above "who authenticates, per remote"). The left rail stays as the
// window's anatomy: its Identity/Remotes entries scroll to the sections
// instead of swapping pages, and `repoSettingsSection` doubles as the deep-
// link scroll hint ("Manage remotes…" lands on the remotes section).

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import {
  DIALOG_LAYER,
  DIALOG_SURFACE,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { useUi, type RepoSettingsSection } from "@/store/ui";
import { useRepo } from "@/store/repo";
import { IdentityPanel } from "@/components/chrome/settings/identity-panel";
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
  const identityRef = useRef<HTMLDivElement>(null);
  const remotesRef = useRef<HTMLDivElement>(null);

  // Sidebar clicks and deep links scroll to the section on the one page.
  // (Optional chaining on the method too — jsdom has no scrollIntoView.)
  useEffect(() => {
    if (!open) return;
    const target = section === "remotes" ? remotesRef : identityRef;
    target.current?.scrollIntoView?.({ block: "start" });
  }, [open, section]);

  if (!open) return null;

  const repoName = repoSlug(forge?.webUrl, summary?.workdir);

  // The two windows are independent; the "App settings" link hands off to global.
  const goGlobal = () => {
    close();
    openGlobalSettings();
  };

  const scrollTo = (next: RepoSettingsSection) => {
    setSection(next);
    // Same-section re-click still scrolls (the effect only fires on change).
    const target = next === "remotes" ? remotesRef : identityRef;
    target.current?.scrollIntoView?.({ block: "start" });
  };

  return (
    <ModalFrame
      z={DIALOG_LAYER.Top}
      labelledBy={TITLE_ID}
      bare
      surface={DIALOG_SURFACE.Window}
      panelClassName="flex h-[min(84vh,880px)] min-h-[420px] w-[min(88vw,1240px)] min-w-[640px] max-w-[94vw] overflow-hidden"
      // Yield focus and dismissal while a nested confirm/prompt (e.g.
      // remove-remote) is open, so its Escape / backdrop doesn't also tear this
      // window down.
      active={!overlayBlocking}
      onDismiss={close}
    >
      <h2 id={TITLE_ID} className="sr-only">
        Repository settings
      </h2>
      <RepoSettingsSidebar
        section={section}
        repoName={repoName}
        onSelect={scrollTo}
        onOpenGlobalSettings={goGlobal}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <button type="button"
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
        {/* One page: identity, then remotes with their account pickers. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-9 pb-10 pt-9">
          <div ref={identityRef} className="scroll-mt-4">
            <IdentityPanel />
          </div>
          <div
            ref={remotesRef}
            className="mt-10 scroll-mt-4 border-t border-black/[0.07] pt-8 dark:border-white/[0.08]"
          >
            <RemotesPanel />
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
