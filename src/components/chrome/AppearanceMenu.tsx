// Title-bar appearance picker. A three-way menu over the persisted theme
// preference (Auto / Light / Dark) — the old button was a two-state flip, so
// `system` could only be reached from Settings and was silently lost on click.
// The trigger mirrors the stored *preference*, not the resolved paint mode, so
// "Auto" keeps its own glyph even when the OS happens to be dark.

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { useUi, type Theme } from "@/store/ui";
import { AutoThemeIcon, MoonIcon, SunIcon } from "@/components/ui/icons";

const OPTIONS: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: "system", label: "Auto", Icon: AutoThemeIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

export function AppearanceMenu() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(
          "grid h-8 w-8 place-items-center rounded-lg",
          open
            ? "rounded-b-none bg-neutral-200 text-[color:var(--accent)] dark:bg-neutral-800"
            : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5",
          focusRing,
        )}
        onClick={() => setOpen((v) => !v)}
        title={`Appearance: ${current.label}`}
        aria-label={`Appearance: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <current.Icon className="h-4 w-4" />
      </button>

      {/* Hangs straight off the trigger (no gap, same width) and lists only the
          other two choices — the current one is already showing in the trigger. */}
      {open && (
        <div
          role="menu"
          aria-label="Appearance"
          className="absolute left-0 top-8 z-[70] flex w-8 flex-col rounded-b-lg bg-neutral-200 pb-1 dark:bg-neutral-800"
        >
          {OPTIONS.filter((o) => o.value !== theme).map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={false}
              title={label}
              aria-label={label}
              className={cn(
                "grid h-[26px] w-8 place-items-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100",
                focusRing,
              )}
              onClick={() => {
                setTheme(value);
                setOpen(false);
              }}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
