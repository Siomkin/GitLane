// The terminal tab strip: one pill per shell for the active repo, a per-tab
// close (×), and a trailing "+" to open another. Purely presentational — the tab
// list lives in `store/terminals` (keyed by repo path) and the live xterm/PTY
// panes are reconciled from it by `useTerminalPanes`. Closing the last tab hides
// the drawer (there is nothing left to show).

import { cn } from "@/lib/cn";
import { useTerminals } from "@/store/terminals";
import { useUi } from "@/store/ui";
import { CloseIcon, PlusIcon, TerminalTabIcon } from "./terminalIcons";

export function TerminalTabs({ repoPath }: { repoPath: string | null }) {
  const byRepo = useTerminals((s) => s.byRepo);
  const openTab = useTerminals((s) => s.openTab);
  const closeTab = useTerminals((s) => s.closeTab);
  const setActiveTab = useTerminals((s) => s.setActiveTab);
  const hideTerminal = useUi((s) => s.hideTerminal);

  if (!repoPath) return null;
  const repo = byRepo[repoPath];
  const tabs = repo?.tabs ?? [];
  const activeId = repo?.activeId ?? null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              aria-label={`Switch to ${tab.title}`}
              onClick={() => setActiveTab(repoPath, tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveTab(repoPath, tab.id);
                }
              }}
              className={cn(
                "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                active
                  ? "bg-black/[0.06] text-neutral-800 dark:bg-white/10 dark:text-neutral-100"
                  : "text-neutral-500 hover:bg-black/[0.03] dark:text-neutral-400 dark:hover:bg-white/[0.05]",
              )}
            >
              <span className="text-neutral-400">
                <TerminalTabIcon />
              </span>
              <span className="max-w-[160px] truncate">{tab.title}</span>
              <button type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (closeTab(repoPath, tab.id)) hideTerminal();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
                className={cn(
                  "grid h-4 w-4 place-items-center rounded text-neutral-400 hover:bg-black/10 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200",
                  active ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                )}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button"
        onClick={() => openTab(repoPath)}
        title="New terminal"
        aria-label="New terminal"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <PlusIcon />
      </button>
    </div>
  );
}
