// General settings: appearance, graph presentation, and the background-fetch
// cadence. All state lives in the UI store; the segmented + swatch controls
// are one-offs used only here, so they stay co-located.
// (Software update lives in the About panel.)

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import {
  AUTO_FETCH_MINUTES,
  sanitizeAutoFetchMinutes,
  useUi,
  type AutoFetchMinutes,
  type Density,
  type Theme,
} from "@/store/ui";
import { ACCENTS, type AccentColor } from "@/lib/accent";
import { SectionLabel, SettingsSwitch } from "./controls";

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
        <button type="button"
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
  const showCommitNodeIcons = useUi((s) => s.showCommitNodeIcons);
  const setShowCommitNodeIcons = useUi((s) => s.setShowCommitNodeIcons);
  const autoFetchEnabled = useUi((s) => s.autoFetchEnabled);
  const setAutoFetchEnabled = useUi((s) => s.setAutoFetchEnabled);
  const autoFetchMinutes = useUi((s) => sanitizeAutoFetchMinutes(s.autoFetchMinutes));
  const setAutoFetchMinutes = useUi((s) => s.setAutoFetchMinutes);

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
      <div className="mb-6">
        <SectionLabel>GRAPH DENSITY</SectionLabel>
        <Segmented<Density>
          value={density}
          options={["Comfortable", "Compact"]}
          onChange={setDensity}
          ariaLabel="Graph density"
        />
      </div>
      <div className="mb-6">
        <SectionLabel>COMMIT NODES</SectionLabel>
        <div className="flex max-w-[420px] items-center justify-between gap-4 rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div>
            <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Commit icons</div>
            <div className="mt-0.5 text-[11.5px] text-neutral-400">
              Show author avatars, co-author badges, and bundled AI co-worker icons. Turn off for classic coloured dots.
            </div>
          </div>
          <SettingsSwitch
            checked={showCommitNodeIcons}
            ariaLabel="Show commit icons"
            onChange={setShowCommitNodeIcons}
          />
        </div>
      </div>
      <div>
        <SectionLabel>BACKGROUND FETCH</SectionLabel>
        <div className="max-w-[420px] rounded-xl border border-black/10 p-3 dark:border-white/10">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Automatically fetch remotes</div>
              <div className="mt-0.5 text-[11.5px] text-neutral-400">Runs only while GitLane is visible, online, and idle.</div>
            </div>
            <SettingsSwitch
              checked={autoFetchEnabled}
              ariaLabel="Automatically fetch remotes"
              onChange={setAutoFetchEnabled}
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <div className="text-[12.5px] text-neutral-600 dark:text-neutral-300">Fetch interval</div>
            <select
              aria-label="Automatic fetch interval"
              value={autoFetchMinutes}
              disabled={!autoFetchEnabled}
              onChange={(event) => setAutoFetchMinutes(Number(event.target.value) as AutoFetchMinutes)}
              className={cn(
                "h-8 rounded-lg border border-black/10 bg-white px-2 text-xs disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900",
                focusRing,
              )}
            >
              {AUTO_FETCH_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m === 60 ? "Every hour" : `Every ${m} min`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
