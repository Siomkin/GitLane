// Keyboard shortcuts reference (GL-346). Rendered entirely from the registry in
// `lib/shortcuts`, so a binding can never appear here without existing (or
// exist without appearing). Read-only — customization is not supported yet.

import { isMac } from "@/lib/platform";
import { SHORTCUTS, ShortcutScope, formatBinding, keysFor, type Shortcut } from "@/lib/shortcuts";
import { SectionLabel } from "@/components/chrome/settings/controls";

const SCOPE_ORDER: ShortcutScope[] = [
  ShortcutScope.Global,
  ShortcutScope.History,
  ShortcutScope.Changes,
  ShortcutScope.Editor,
  ShortcutScope.Dialogs,
];

function KeyCap({ shortcut }: { shortcut: Shortcut }) {
  return (
    <kbd className="rounded-md border border-black/10 bg-black/[0.04] px-2 py-1 font-sans text-[12px] font-semibold text-neutral-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-300">
      {formatBinding(shortcut, isMac)}
    </kbd>
  );
}

export function ShortcutsPanel() {
  // A shortcut can be macOS-only; skip it where it isn't offered.
  const available = SHORTCUTS.filter((shortcut) => keysFor(shortcut, isMac) !== null);

  return (
    <div className="max-w-[660px]">
      <div className="mb-1 text-[19px] font-bold text-neutral-800 dark:text-neutral-100">
        Keyboard Shortcuts
      </div>
      <div className="mb-[26px] text-[13px] text-neutral-500 dark:text-neutral-400">
        Every shortcut GitLane supports on {isMac ? "macOS" : "this platform"}. Shortcuts stand down
        while you are typing, while a dialog is open, and — apart from tab switching — while the
        terminal has focus.
      </div>

      {SCOPE_ORDER.map((scope) => {
        const rows = available.filter((shortcut) => shortcut.scope === scope);
        if (rows.length === 0) return null;
        return (
          <div key={scope} className="mb-6">
            <SectionLabel>{scope.toUpperCase()}</SectionLabel>
            <div className="rounded-xl border border-black/10 dark:border-white/10">
              {rows.map((shortcut, index) => (
                <div
                  key={shortcut.id}
                  className={
                    index === 0
                      ? "flex items-center gap-4 px-4 py-2.5"
                      : "flex items-center gap-4 border-t border-black/5 px-4 py-2.5 dark:border-white/5"
                  }
                >
                  <span className="flex-1 text-[13px] text-neutral-700 dark:text-neutral-300">
                    {shortcut.description}
                  </span>
                  <KeyCap shortcut={shortcut} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
