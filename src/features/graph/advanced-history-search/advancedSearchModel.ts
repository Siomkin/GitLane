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

/** Local YYYY-MM-DD for a Date — the format the date filters parse. Local date
 * parts, not toISOString: the UTC shift would be off by a day east of Greenwich. */
export function localDateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Placeholders for the (plain-text) date inputs: a one-year-back hint for the
 * lower bound and today for the upper. Placeholders only — the fields start
 * empty and no filter is active until the user types one. Text inputs because
 * native date inputs can't show placeholders (WebKit paints today's date into
 * an empty one, which reads as a confusing "today to today" range). */
export function datePlaceholders(now = new Date()): { since: string; until: string } {
  const from = new Date(now);
  from.setFullYear(from.getFullYear() - 1);
  return { since: localDateString(from), until: localDateString(now) };
}

/** A date filter value is usable when empty (inactive) or a real calendar date
 * in YYYY-MM-DD form. The date fields are free-text (native date inputs can't
 * show placeholders), so anything can be typed — an unparseable value must be
 * flagged to the user rather than silently dropped from the query. */
export function isValidDateInput(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  // Round-trip through Date parts: engines roll impossible calendar days over
  // (2026-02-30 → Mar 2) instead of rejecting them, so compare component-wise.
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
  );
}

/** Mask free-typed date text as YYYY-MM-DD: digits only, dashes inserted
 * automatically, so "20250715", "2025-07-15", and stray separators all settle
 * to the same value. Deletion-friendly by construction — a dash is only added
 * once the digit after it exists, so backspacing "2025-0" yields "2025", not a
 * sticky trailing dash. Deliberately no masking library for two fields. */
export function formatDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  let out = digits.slice(0, 4);
  if (digits.length > 4) out += `-${digits.slice(4, 6)}`;
  if (digits.length > 6) out += `-${digits.slice(6, 8)}`;
  return out;
}

/** Local-time day bounds for the date inputs (inclusive on both ends).
 * Undefined for empty or invalid input — invalid never reaches the backend. */
export function dayStartSeconds(date: string): number | undefined {
  const text = date.trim();
  if (!text || !isValidDateInput(text)) return undefined;
  return Math.floor(new Date(`${text}T00:00:00`).getTime() / 1000);
}
export function dayEndSeconds(date: string): number | undefined {
  const text = date.trim();
  if (!text || !isValidDateInput(text)) return undefined;
  return Math.floor(new Date(`${text}T23:59:59`).getTime() / 1000);
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
  // Only valid dates become chips — a chip asserts the filter is active, and
  // an unparseable date never reaches the query (the field shows the error).
  if (fields.since.trim() && isValidDateInput(fields.since)) {
    chips.push({ key: "since", label: `After ${fields.since.trim()}` });
  }
  if (fields.until.trim() && isValidDateInput(fields.until)) {
    chips.push({ key: "until", label: `Before ${fields.until.trim()}` });
  }
  return chips;
}
