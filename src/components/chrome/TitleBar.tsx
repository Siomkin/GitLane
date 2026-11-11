import { isMac, isTauri } from "@/lib/platform";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { ChevronRightIcon, PlusIcon, SearchIcon, SettingsIcon } from "@/components/ui/icons";
import { AppearanceMenu } from "./AppearanceMenu";
import { IdentityChip } from "./IdentityChip";
import { RepoTabStrip } from "./repo-tabs/RepoTabStrip";
import { useChromeShortcuts } from "./useShortcuts";
import { useTabStripScroll } from "./useTabStripScroll";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowControls } from "./WindowControls";

/** The title-bar Search opens the same quick history search as ⌘F: return to
 * the graph from whatever center view is open (where the search bar lives) and
 * open it if it's closed. */
const openHistorySearch = () => {
  const repo = useRepo.getState();
  repo.guardDirtyFileView(() => {
    repo.returnToGraph();
    const ui = useUi.getState();
    if (!ui.histSearchOpen) ui.toggleHistSearch();
  });
};

export const TitleBar = () => {
  const openPaths = useRepo((state) => state.openPaths);
  const onSettings = useUi((state) => state.openSettings);
  const openOnboarding = useUi((state) => state.openOnboarding);
  // Tab switching and Settings live here rather than in the toolbar (GL-346):
  // the toolbar unmounts when a repo can't be loaded, and moving off a broken
  // tab by keyboard has to keep working on that screen.
  useChromeShortcuts();
  const strip = useTabStripScroll(
    useRepo((state) => state.summary?.path ?? state.missingRepo?.path ?? null),
  );

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-4 px-4"
    >
      {/* Reserve room for the native macOS traffic-light buttons, which overlay
          the top-left corner (titleBarStyle: Overlay). Windows/Linux are
          frameless with our own <WindowControls> at the right, so no spacer. */}
      {isMac && <div data-tauri-drag-region aria-hidden="true" className="w-[58px] shrink-0" />}

      {/* No scrollbar: pressing a tab starts a drag, so a mouse reaches hidden
          tabs through the wheel or these edge arrows, drawn over the fade. */}
      <div className="relative min-w-0">
        {strip.edges.start && (
          <button type="button"
            className="absolute left-0 top-1/2 z-10 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            onClick={() => strip.page(-1)}
            title="Scroll tabs left"
            aria-label="Scroll tabs left"
          >
            <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
          </button>
        )}
        {strip.edges.end && (
          <button type="button"
            className="absolute right-0 top-1/2 z-10 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
            onClick={() => strip.page(1)}
            title="Scroll tabs right"
            aria-label="Scroll tabs right"
          >
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <div
          ref={strip.scrollerRef}
          style={strip.style}
          className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref={strip.contentRef} className="flex w-max items-center gap-1">
            <RepoTabStrip />
            {openPaths.length > 0 && (
              <button type="button"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
                onClick={openOnboarding}
                title="Open or create a repository"
                aria-label="Open or create a repository"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div data-tauri-drag-region className="ml-auto flex items-center gap-1">
        <button type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/5"
          onClick={openHistorySearch}
          disabled={openPaths.length === 0}
          title="Search history"
          aria-label="Search"
        >
          <SearchIcon className="h-4 w-4" />
        </button>
        <button type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          onClick={() => onSettings()}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
        <AppearanceMenu />
        <UpdateIndicator />
        <div className="mx-1.5 h-5 w-px bg-black/10 dark:bg-white/10" />
        <IdentityChip />
      </div>

      {/* Windows/Linux frameless caption controls; macOS uses native traffic lights. */}
      {!isMac && isTauri && <WindowControls />}
    </header>
  );
};
