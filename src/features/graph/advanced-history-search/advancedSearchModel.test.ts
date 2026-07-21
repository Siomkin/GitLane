import { describe, expect, it } from "vitest";
import { EMPTY_FIELDS, activeFilterChips, datePlaceholders, formatDateInput, isValidDateInput, toQuery, type FormFields } from "./advancedSearchModel";

const fields = (over: Partial<FormFields>): FormFields => ({ ...EMPTY_FIELDS, ...over });

describe("toQuery", () => {
  it("routes the changed text to occurrenceText in literal mode and clears the regex", () => {
    const q = toQuery(fields({ changed: "invoke(" }), "literal");
    expect(q.occurrenceText).toBe("invoke(");
    expect(q.changedPattern).toBe("");
  });

  it("routes the changed text to changedPattern in regex mode and clears the literal", () => {
    const q = toQuery(fields({ changed: "invoke\\(" }), "regex");
    expect(q.changedPattern).toBe("invoke\\(");
    expect(q.occurrenceText).toBe("");
  });

  it("converts the date fields to inclusive epoch-second bounds", () => {
    const q = toQuery(fields({ since: "2026-07-15", until: "2026-07-15" }), "literal");
    // until is the end of the day, so it must be strictly after since.
    expect(q.sinceTimestamp).toBeTypeOf("number");
    expect(q.untilTimestamp! - q.sinceTimestamp!).toBe(86399);
  });

  it("leaves the date bounds undefined when empty", () => {
    const q = toQuery(EMPTY_FIELDS, "literal");
    expect(q.sinceTimestamp).toBeUndefined();
    expect(q.untilTimestamp).toBeUndefined();
  });
});

describe("activeFilterChips", () => {
  it("emits nothing when no filter is set", () => {
    expect(activeFilterChips(EMPTY_FIELDS, "literal")).toEqual([]);
  });

  it("emits one chip per non-empty filter in field order", () => {
    const chips = activeFilterChips(
      fields({ message: "fix", author: "Ann", path: "src", revision: "main..dev" }),
      "literal",
    );
    expect(chips.map((c) => c.label)).toEqual([
      "Message: fix",
      "Author: Ann",
      "Path: src",
      "Revision: main..dev",
    ]);
  });

  it("labels the changed chip with the active match mode", () => {
    expect(activeFilterChips(fields({ changed: "x" }), "literal")[0].label).toBe("Exact text: x");
    expect(activeFilterChips(fields({ changed: "x" }), "regex")[0].label).toBe("Regex: x");
  });

  it("labels the date chips After/Before and keys them to the field they clear", () => {
    const chips = activeFilterChips(fields({ since: "2026-01-01", until: "2026-02-01" }), "literal");
    expect(chips).toEqual([
      { key: "since", label: "After 2026-01-01" },
      { key: "until", label: "Before 2026-02-01" },
    ]);
  });

  it("ignores whitespace-only filters", () => {
    expect(activeFilterChips(fields({ message: "   " }), "literal")).toEqual([]);
  });
});

describe("datePlaceholders", () => {
  it("hints one year back for since and today for until, as local dates", () => {
    const hints = datePlaceholders(new Date("2026-07-15T12:00:00"));
    expect(hints.since).toBe("2025-07-15");
    expect(hints.until).toBe("2026-07-15");
  });

  it("pads single-digit months and days", () => {
    expect(datePlaceholders(new Date("2026-02-03T12:00:00")).since).toBe("2025-02-03");
  });
});

describe("isValidDateInput / invalid-date handling", () => {
  it("accepts empty and real YYYY-MM-DD dates, rejects everything else", () => {
    expect(isValidDateInput("")).toBe(true);
    expect(isValidDateInput("2026-07-15")).toBe(true);
    expect(isValidDateInput("2223213123")).toBe(false);
    expect(isValidDateInput("07/15/2026")).toBe(false);
    expect(isValidDateInput("2026-7-15")).toBe(false);
    expect(isValidDateInput("2026-02-30")).toBe(false);
  });

  it("keeps invalid dates out of the query and the chips", () => {
    const bad = fields({ since: "2223213123" });
    expect(toQuery(bad, "literal").sinceTimestamp).toBeUndefined();
    expect(activeFilterChips(bad, "literal")).toEqual([]);
  });
});

describe("formatDateInput", () => {
  it("inserts dashes as digits arrive", () => {
    expect(formatDateInput("2")).toBe("2");
    expect(formatDateInput("2025")).toBe("2025");
    expect(formatDateInput("20250")).toBe("2025-0");
    expect(formatDateInput("202507")).toBe("2025-07");
    expect(formatDateInput("2025071")).toBe("2025-07-1");
    expect(formatDateInput("20250715")).toBe("2025-07-15");
  });

  it("normalizes pasted separators and trims overflow", () => {
    expect(formatDateInput("2025-07-15")).toBe("2025-07-15");
    expect(formatDateInput("2025/07/15")).toBe("2025-07-15");
    expect(formatDateInput("2025.07.15.999")).toBe("2025-07-15");
    expect(formatDateInput("abc")).toBe("");
  });

  it("never leaves a trailing dash, so backspace deletes through it", () => {
    // "2025-0" minus its last char is "2025-", which must settle to "2025".
    expect(formatDateInput("2025-")).toBe("2025");
    expect(formatDateInput("2025-07-")).toBe("2025-07");
  });
});
