import { isMac, isTauri } from "@/lib/platform";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from "@/components/ui/icons";
import { IdentityChip } from "./IdentityChip";
import { RepoTabStrip } from "./repo-tabs/RepoTabStrip";
import { useChromeShortcuts } from "./useShortcuts";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowControls } from "./WindowControls";

export const TitleBar = () => {
  const openPaths = useRepo((state) => state.openPaths);
  const theme = useResolvedTheme();
  const toggleTheme = useUi((state) => state.toggleTheme);
  const onSettings = useUi((state) => state.openSettings);
  const openOnboarding = useUi((state) => state.openOnboarding);
  // Tab switching and Settings live here rather than in the toolbar (GL-346):
  // the toolbar unmounts when a repo can't be loaded, and moving off a broken
  // tab by keyboard has to keep working on that screen.
  useChromeShortcuts();

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-4 px-4"
    >
      {/* Reserve room for the native macOS traffic-light buttons, which overlay
          the top-left corner (titleBarStyle: Overlay). Windows/Linux are
          frameless with our own <WindowControls> at the right, so no spacer. */}
      {isMac && <div data-tauri-drag-region aria-hidden="true" className="w-[58px] shrink-0" />}

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
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

      <div data-tauri-drag-region className="ml-auto flex items-center gap-1">
        <button type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          title="Search"
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
        <button type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          onClick={toggleTheme}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
        </button>
        <UpdateIndicator />
        <div className="mx-1.5 h-5 w-px bg-black/10 dark:bg-white/10" />
        <IdentityChip />
      </div>

      {/* Windows/Linux frameless caption controls; macOS uses native traffic lights. */}
      {!isMac && isTauri && <WindowControls />}
    </header>
  );
};
