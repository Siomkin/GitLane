import type { SuggestItem } from "@/components/ui/SuggestInput";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import {
  CHANGED_MODES,
  type ActiveFilterChip,
  type ChangedMode,
  type FormFields,
} from "./advancedSearchModel";
import { FieldLabel } from "./FieldLabel";
import { SearchField } from "./SearchField";
import { completeRevision } from "./searchSuggestions";
import { INPUT_CLASS } from "./styles";

export interface AdvancedHistorySearchFormProps {
  fields: FormFields;
  dateHints: { since: string; until: string };
  changedMode: ChangedMode;
  chips: ActiveFilterChip[];
  authorItems: SuggestItem[];
  pathItems: SuggestItem[];
  revisionItems: SuggestItem[];
  showSinceInvalid: boolean;
  showUntilInvalid: boolean;
  showDatesInvalid: boolean;
  loading: boolean;
  searchDisabled: boolean;
  onUpdate: (key: keyof FormFields, value: string) => void;
  onChangedModeChange: (mode: ChangedMode) => void;
  onDateKeyDown: (
    key: "since" | "until",
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => void;
  onDateFocus: (key: "since" | "until") => void;
  onDateBlur: () => void;
  onClearAll: () => void;
  onSearch: () => void;
}

export function AdvancedHistorySearchForm({
  fields,
  dateHints,
  changedMode,
  chips,
  authorItems,
  pathItems,
  revisionItems,
  showSinceInvalid,
  showUntilInvalid,
  showDatesInvalid,
  loading,
  searchDisabled,
  onUpdate,
  onChangedModeChange,
  onDateKeyDown,
  onDateFocus,
  onDateBlur,
  onClearAll,
  onSearch,
}: AdvancedHistorySearchFormProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <SearchField
          label="Message"
          placeholder="regex — fix|refactor"
          value={fields.message}
          onChange={(value) => onUpdate("message", value)}
        />
        <label className="min-w-0">
          <FieldLabel>Author</FieldLabel>
          <SuggestInput
            value={fields.author}
            onChange={(value) => onUpdate("author", value)}
            onPick={(value) => onUpdate("author", value)}
            items={authorItems}
            placeholder="name or email"
            className={INPUT_CLASS}
            hintPlacement="inline"
          />
        </label>
        <label className="min-w-0">
          <FieldLabel>File path</FieldLabel>
          <SuggestInput
            value={fields.path}
            onChange={(value) => onUpdate("path", value)}
            onPick={(value) => onUpdate("path", value)}
            items={pathItems}
            placeholder="src/store"
            className={INPUT_CLASS}
          />
        </label>
        <label className="min-w-0">
          <FieldLabel>Revision or range</FieldLabel>
          <SuggestInput
            value={fields.revision}
            onChange={(value) => onUpdate("revision", value)}
            onPick={(value) => onUpdate("revision", completeRevision(fields.revision, value))}
            items={revisionItems}
            placeholder="main or main..feature"
            className={INPUT_CLASS}
          />
        </label>
        <label className="min-w-0">
          <FieldLabel
            trailing={
              <span role="radiogroup" aria-label="Changed code match mode" className="flex gap-0.5">
                {CHANGED_MODES.map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    role="radio"
                    aria-checked={changedMode === mode.key}
                    onClick={() => onChangedModeChange(mode.key)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors",
                      changedMode === mode.key
                        ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                        : "text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5",
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </span>
            }
          >
            Changed code
          </FieldLabel>
          <input
            value={fields.changed}
            onChange={(event) => onUpdate("changed", event.target.value)}
            placeholder={changedMode === "literal" ? "invoke(" : "invoke\\("}
            className={INPUT_CLASS}
          />
        </label>
        <div className="min-w-0">
          <FieldLabel>Date range</FieldLabel>
          <div className="flex items-center gap-1.5">
            <input
              value={fields.since}
              onChange={(event) => onUpdate("since", event.target.value)}
              placeholder={dateHints.since}
              inputMode="numeric"
              aria-label="Committed after"
              aria-invalid={showSinceInvalid || undefined}
              onKeyDown={(event) => onDateKeyDown("since", event)}
              onFocus={() => onDateFocus("since")}
              onBlur={onDateBlur}
              className={cn(
                INPUT_CLASS,
                showSinceInvalid && "border-red-400 focus:border-red-400 dark:border-red-500/70",
              )}
            />
            <span className="text-[10px] text-neutral-400">to</span>
            <input
              value={fields.until}
              onChange={(event) => onUpdate("until", event.target.value)}
              placeholder={dateHints.until}
              inputMode="numeric"
              aria-label="Committed before"
              aria-invalid={showUntilInvalid || undefined}
              onKeyDown={(event) => onDateKeyDown("until", event)}
              onFocus={() => onDateFocus("until")}
              onBlur={onDateBlur}
              className={cn(
                INPUT_CLASS,
                showUntilInvalid && "border-red-400 focus:border-red-400 dark:border-red-500/70",
              )}
            />
          </div>
        </div>
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--accent-soft)] py-0.5 pl-2 pr-1 text-[11px] font-medium text-[color:var(--accent)]"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                onClick={() => onUpdate(chip.key, "")}
                aria-label={`Remove ${chip.label} filter`}
                className="grid h-4 w-4 shrink-0 place-items-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={onClearAll}
            className="ml-0.5 text-[11px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            Clear all
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[10px]",
            showDatesInvalid ? "text-red-500 dark:text-red-400" : "text-neutral-400",
          )}
        >
          {showDatesInvalid
            ? `Dates must be YYYY-MM-DD, like ${dateHints.since}.`
            : "Non-empty filters are combined."}
        </span>
        <button
          type="submit"
          disabled={searchDisabled}
          className="h-7 rounded-md bg-[var(--accent)] px-3 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Searching…" : "Search repository"}
        </button>
      </div>
    </form>
  );
}
