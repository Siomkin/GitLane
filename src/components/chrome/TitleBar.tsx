import { cn } from "../../lib/cn";
import { isMac, isTauri } from "../../lib/platform";
import { repoLabel } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import { FolderIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from "../ui/icons";
import { AccountChip } from "./AccountChip";
import { WindowControls } from "./WindowControls";

export function TitleBar() {
  const summary = useRepo((state) => state.summary);
  const openPaths = useRepo((state) => state.openPaths);
  const loadRepo = useRepo((state) => state.loadRepo);
  const closeRepo = useRepo((state) => state.closeRepo);
  const pickAndOpen = useRepo((state) => state.pickAndOpen);
  const theme = useResolvedTheme();
  const toggleTheme = useUi((state) => state.toggleTheme);
  const onSettings = useUi((state) => state.openSettings);
  const activePath = summary?.path ?? null;

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-4 px-4"
    >
      {/* Reserve room for the native macOS traffic-light buttons, which overlay
          the top-left corner (titleBarStyle: Overlay). Windows/Linux are
          frameless with our own <WindowControls> at the right, so no spacer. */}
      {isMac && <div data-tauri-drag-region aria-hidden="true" className="w-[58px] shrink-0" />}

      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {openPaths.map((path) => {
          const active = path === activePath;
          return (
            <div
              key={path}
              className={cn(
                "group flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px]",
                active
                  ? "bg-white font-medium text-neutral-800 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
                  : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
              )}
            >
              <button
                className="flex min-w-0 items-center gap-2"
                onClick={() => !active && loadRepo(path)}
                title={path}
              >
                <FolderIcon
                  className={cn("h-3.5 w-3.5 shrink-0", active ? "text-[color:var(--accent)]" : "text-neutral-400")}
                />
                <span className="truncate">{repoLabel(path)}</span>
              </button>
              <button
                className="grid h-4 w-4 place-items-center rounded text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeRepo(path);
                }}
                title="Close repository"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-2.5 w-2.5">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        })}
        <button
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
          onClick={pickAndOpen}
          title="Open another repository"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
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
        <div className="mx-1.5 h-5 w-px bg-black/10 dark:bg-white/10" />
        <AccountChip />
      </div>

      {/* Windows/Linux frameless caption controls; macOS uses native traffic lights. */}
      {!isMac && isTauri && <WindowControls />}
    </header>
  );
}
