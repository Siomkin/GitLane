// General settings: appearance (theme), accent colour, graph density, and the
// software-update section. Theme/accent/density live in the UI store; the update
// section reads its own `useUpdates` store. The segmented + swatch controls are
// one-offs used only here, so they stay co-located.

import { cn } from "../../../lib/cn";
import { focusRing } from "../../../lib/ui";
import { useUi, type Density, type Theme } from "../../../store/ui";
import { ACCENTS, type AccentColor } from "../../../lib/accent";
import { SectionLabel } from "./controls";
import { UpdateSection } from "./UpdateSection";

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: T[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex max-w-[320px] gap-1 rounded-lg bg-black/[0.06] p-1 dark:bg-white/[0.06]"
    >
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={cn(
            "flex-1 rounded-md py-1.5 text-[13px] font-semibold capitalize",
            value === option
              ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100",
            focusRing,
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function AccentSwatches({
  value,
  onChange,
}: {
  value: AccentColor;
  onChange: (value: AccentColor) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2.5">
      {ACCENTS.map((accent) => {
        const selected = value === accent.id;
        return (
          <button
            key={accent.id}
            type="button"
            onClick={() => onChange(accent.id)}
            title={accent.label}
            aria-label={accent.label}
            aria-pressed={selected}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-full text-white ring-offset-2 transition ring-offset-white focus:outline-none focus-visible:ring-2 dark:ring-offset-neutral-800",
              selected ? "ring-2" : "ring-0 hover:scale-110",
            )}
            style={{ backgroundColor: accent.hex, ...({ "--tw-ring-color": accent.hex } as React.CSSProperties) }}
          >
            {selected && (
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3.2}>
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function GeneralPanel() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const accent = useUi((s) => s.accent);
  const setAccent = useUi((s) => s.setAccent);
  const density = useUi((s) => s.density);
  const setDensity = useUi((s) => s.setDensity);

  return (
    <>
      <div className="mb-1 text-[19px] font-bold text-neutral-800 dark:text-neutral-100">General</div>
      <div className="mb-[26px] text-[13px] text-neutral-500 dark:text-neutral-400">Appearance and layout preferences.</div>
      <div className="mb-6">
        <SectionLabel>APPEARANCE</SectionLabel>
        <Segmented<Theme>
          value={theme}
          options={["dark", "light", "system"]}
          onChange={setTheme}
          ariaLabel="Appearance theme"
        />
      </div>
      <div className="mb-6">
        <SectionLabel>ACCENT COLOR</SectionLabel>
        <AccentSwatches value={accent} onChange={setAccent} />
      </div>
      <div>
        <SectionLabel>GRAPH DENSITY</SectionLabel>
        <Segmented<Density>
          value={density}
          options={["Comfortable", "Compact"]}
          onChange={setDensity}
          ariaLabel="Graph density"
        />
      </div>
      <UpdateSection />
    </>
  );
}
