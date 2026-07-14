import { describe, expect, it } from "vitest";
import {
  composeConventionalMessage,
  conventionalSubjectLine,
  parseConventionalMessage,
  SubjectMeterTone,
  subjectMeterTone,
  type ConventionalFields,
} from "./conventionalCommit";

const fields = (over: Partial<ConventionalFields> = {}): ConventionalFields => ({
  type: "",
  scope: "",
  subject: "",
  body: "",
  ...over,
});

describe("parseConventionalMessage", () => {
  it("splits type, scope, subject, and body", () => {
    expect(parseConventionalMessage("feat(graph): add lane colors\n\nBecause lanes.")).toEqual({
      type: "feat",
      scope: "graph",
      subject: "add lane colors",
      body: "Because lanes.",
    });
  });

  it("parses a scopeless subject", () => {
    expect(parseConventionalMessage("fix: keep this message")).toEqual({
      type: "fix",
      scope: "",
      subject: "keep this message",
      body: "",
    });
  });

  it("keeps a type outside the dropdown list", () => {
    expect(parseConventionalMessage("build: bump deps").type).toBe("build");
  });

  it("falls back to a plain subject for unconventional summaries", () => {
    for (const summary of [
      "GL-217 feat(commit): prefixed ticket key",
      "feat!: breaking marker",
      "Fix things",
      "feat:missing space",
    ]) {
      expect(parseConventionalMessage(summary)).toEqual({
        type: "",
        scope: "",
        subject: summary,
        body: "",
      });
    }
  });
});

describe("composeConventionalMessage", () => {
  it("round-trips through parse", () => {
    const message = "chore(docker): restart services unless stopped\n\nSet restart: unless-stopped.";
    expect(composeConventionalMessage(parseConventionalMessage(message))).toBe(message);
  });

  it("omits the prefix without a type and the parens without a scope", () => {
    expect(composeConventionalMessage(fields({ subject: "plain subject" }))).toBe("plain subject");
    expect(composeConventionalMessage(fields({ type: "fix", subject: "s" }))).toBe("fix: s");
    expect(composeConventionalMessage(fields({ type: "fix", scope: "ui", subject: "s" }))).toBe(
      "fix(ui): s",
    );
  });

  it("appends the body after a blank line", () => {
    expect(composeConventionalMessage(fields({ subject: "s", body: "why" }))).toBe("s\n\nwhy");
  });

  it("produces an empty message from empty fields", () => {
    expect(composeConventionalMessage(fields())).toBe("");
  });
});

describe("subjectMeterTone", () => {
  it("maps lengths to tones", () => {
    expect(subjectMeterTone(0, false)).toBe(SubjectMeterTone.Empty);
    expect(subjectMeterTone(12, true)).toBe(SubjectMeterTone.Ok);
    expect(subjectMeterTone(51, true)).toBe(SubjectMeterTone.Warn);
    expect(subjectMeterTone(73, true)).toBe(SubjectMeterTone.Over);
  });

  it("measures the full composed subject line", () => {
    expect(conventionalSubjectLine(fields({ type: "feat", scope: "graph", subject: "abc" }))).toBe(
      "feat(graph): abc",
    );
  });
});
