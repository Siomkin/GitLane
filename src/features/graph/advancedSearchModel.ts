// Pure, IPC-free model for the advanced history search form: the field shape,
// how it maps to a backend HistorySearchQuery, and how active (non-empty)
// filters derive into removable chips. Kept out of the component so query
// construction and chip derivation are unit-testable in isolation.

import type { HistorySearchQuery } from "@/lib/api";

/** How the "Changed code" text is matched against each commit's diff: exact
 * text mirrors `git log -S` (occurrence count changed), regex mirrors `-G`
 * (pattern appears on an added/removed line). One field, two engines. */
export const CHANGED_MODES = [
  { key: "literal", label: "Exact text" },
  { key: "regex", label: "Regex" },
] as const;
export type ChangedMode = (typeof CHANGED_MODES)[number]["key"];

export function changedModeLabel(mode: ChangedMode): string {
  return CHANGED_MODES.find((entry) => entry.key === mode)?.label ?? "Exact text";
}

export interface FormFields {
  message: string;
  author: string;
  path: string;
  revision: string;
  changed: string;
  since: string;
  until: string;
}

export const EMPTY_FIELDS: FormFields = {
  message: "",
  author: "",
  path: "",
  revision: "",
  changed: "",
  since: "",
  until: "",
};

/** Local-time day bounds for the date inputs (inclusive on both ends). */
export function dayStartSeconds(date: string): number | undefined {
  if (!date) return undefined;
  const ms = new Date(`${date}T00:00:00`).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}
export function dayEndSeconds(date: string): number | undefined {
  if (!date) return undefined;
  const ms = new Date(`${date}T23:59:59`).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export function toQuery(fields: FormFields, changedMode: ChangedMode): HistorySearchQuery {
  return {
    messagePattern: fields.message,
    author: fields.author,
    path: fields.path,
    revision: fields.revision,
    changedPattern: changedMode === "regex" ? fields.changed : "",
    occurrenceText: changedMode === "literal" ? fields.changed : "",
    sinceTimestamp: dayStartSeconds(fields.since),
    untilTimestamp: dayEndSeconds(fields.until),
    limit: 200,
  };
}

/** One active filter, rendered as a removable chip. `key` is the field the
 * chip's × button clears. */
export interface ActiveFilterChip {
  key: keyof FormFields;
  label: string;
}

/** The non-empty filters, in field order, as chips. The "changed" chip's
 * prefix tracks the active match mode so the chip reads the same as the field
 * ("Exact text: …" / "Regex: …"); the date chips read "After …"/"Before …". */
export function activeFilterChips(fields: FormFields, changedMode: ChangedMode): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const push = (key: keyof FormFields, prefix: string) => {
    const value = fields[key].trim();
    if (value) chips.push({ key, label: `${prefix}: ${value}` });
  };
  push("message", "Message");
  push("author", "Author");
  push("path", "Path");
  push("revision", "Revision");
  if (fields.changed.trim()) {
    chips.push({ key: "changed", label: `${changedModeLabel(changedMode)}: ${fields.changed.trim()}` });
  }
  if (fields.since.trim()) chips.push({ key: "since", label: `After ${fields.since.trim()}` });
  if (fields.until.trim()) chips.push({ key: "until", label: `Before ${fields.until.trim()}` });
  return chips;
}
