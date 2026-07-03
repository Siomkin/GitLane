import { useCallback } from "react";
import { DragDropProvider, type DragEndEvent } from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import { isMac, isTauri } from "../../lib/platform";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import { MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from "../ui/icons";
import { IdentityChip } from "./IdentityChip";
import { ProjectTab } from "./ProjectTab";
import { UpdateIndicator } from "./UpdateIndicator";
import { WindowControls } from "./WindowControls";

export const TitleBar = () => {
  const summary = useRepo((state) => state.summary);
  const missingPath = useRepo((state) => state.missingRepo?.path ?? null);
  const openPaths = useRepo((state) => state.openPaths);
  const recents = useRepo((state) => state.recents);
  const loadRepo = useRepo((state) => state.loadRepo);
  const closeRepo = useRepo((state) => state.closeRepo);
  const reorderOpenPaths = useRepo((state) => state.reorderOpenPaths);
  const theme = useResolvedTheme();
  const toggleTheme = useUi((state) => state.toggleTheme);
  const onSettings = useUi((state) => state.openSettings);
  const openOnboarding = useUi((state) => state.openOnboarding);
  const closeOnboarding = useUi((state) => state.closeOnboarding);
  // The missing-repo state (GL-108) owns the tab strip like a live repo would,
  // so its tab highlights while the recovery screen is up.
  const activePath = summary?.path ?? missingPath;

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.canceled) return;
      const { source } = event.operation;
      if (!isSortable(source)) return;
      reorderOpenPaths(source.initialIndex, source.index);
    },
    [reorderOpenPaths],
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

      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        <DragDropProvider onDragEnd={handleProjectDragEnd}>
          {openPaths.map((path, index) => {
            const active = path === activePath;
            // A background tab is flagged too when its path is already known
            // dead — via the recents probe or a previously entered missing
            // state — so a dead tab reads amber before it's ever clicked.
            const missing =
              path === missingPath || !!recents.find((r) => r.path === path)?.missing;
            return (
              <ProjectTab
                key={path}
                path={path}
                index={index}
                active={active}
                missing={missing}
                onSelect={() => {
                  closeOnboarding();
                  if (!active) void loadRepo(path);
                }}
                onClose={() => void closeRepo(path)}
              />
            );
          })}
        </DragDropProvider>
        {openPaths.length > 0 && (
          <button
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
            onClick={openOnboarding}
            title="Open or create a repository"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div data-tauri-drag-region className="ml-auto flex items-center gap-1">
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          title="Search"
        >
          <SearchIcon className="h-4 w-4" />
        </button>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          onClick={() => onSettings()}
          title="Settings"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
          onClick={toggleTheme}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
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
