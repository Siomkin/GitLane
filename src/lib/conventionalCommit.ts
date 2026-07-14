// Conventional-commit model for the inline commit composer: the optional
// structured `type(scope): subject` style offered next to the free-form
// message, plus the subject-length meter thresholds. Pure — no React, no
// stores — so parsing/composition round-trips are unit-testable.

import { fullCommitMessage, splitCommitMessage } from "./commitMessage";

/** Commit types offered by the composer's type dropdown. A parsed message may
 * carry a type outside this list (e.g. `build`); the editor keeps it as an
 * extra option so re-composing never loses it. */
export const COMMIT_TYPES = ["feat", "fix", "chore", "docs", "refactor", "perf", "test"] as const;

/** The two message styles of the commit composer. */
export const ComposerMode = {
  Message: "message",
  Conventional: "conventional",
} as const;
export type ComposerMode = (typeof ComposerMode)[keyof typeof ComposerMode];

export interface ConventionalFields {
  /** Conventional type (`feat`, `fix`, …) or `""` for an untyped subject. */
  type: string;
  scope: string;
  subject: string;
  body: string;
}

/** Above this the meter turns amber — the conventional soft subject limit. */
export const SUBJECT_SOFT_LIMIT = 50;
/** Above this the meter turns red — git UIs truncate around 72 characters. */
export const SUBJECT_HARD_LIMIT = 72;

/** `type(scope): subject` — type lowercase, scope free of parens, one space
 * after the colon (the conventional-commits shape). Markers this doesn't
 * model (`feat!:`, ticket prefixes) fall back to a plain subject, verbatim. */
const SUBJECT_RE = /^([a-z][a-z0-9-]*)(?:\(([^()]*)\))?: (.*)$/;

export function parseConventionalMessage(message: string): ConventionalFields {
  const { summary, description } = splitCommitMessage(message);
  const match = SUBJECT_RE.exec(summary);
  if (!match) return { type: "", scope: "", subject: summary, body: description };
  return { type: match[1], scope: match[2] ?? "", subject: match[3], body: description };
}

/** The composed subject line (what the meter measures). */
export function conventionalSubjectLine(fields: ConventionalFields): string {
  const scope = fields.scope.trim();
  const prefix = fields.type ? `${fields.type}${scope ? `(${scope})` : ""}: ` : "";
  return `${prefix}${fields.subject}`.trimEnd();
}

export function composeConventionalMessage(fields: ConventionalFields): string {
  return fullCommitMessage(conventionalSubjectLine(fields), fields.body);
}

export const SubjectMeterTone = {
  Empty: "empty",
  Ok: "ok",
  Warn: "warn",
  Over: "over",
} as const;
export type SubjectMeterTone = (typeof SubjectMeterTone)[keyof typeof SubjectMeterTone];

export function subjectMeterTone(length: number, hasSubject: boolean): SubjectMeterTone {
  if (length > SUBJECT_HARD_LIMIT) return SubjectMeterTone.Over;
  if (length > SUBJECT_SOFT_LIMIT) return SubjectMeterTone.Warn;
  return hasSubject ? SubjectMeterTone.Ok : SubjectMeterTone.Empty;
}
