// Message surface of the inline commit composer (commit panel redesign): a
// segmented Message / Conventional style switch, the structured
// `type(scope): subject` line with a live length meter, the optional body, and
// the free-form textarea. Presentational — field state and message
// composition live in the container.

import type { ReactNode } from "react";

import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import {
  COMMIT_TYPES,
  ComposerMode,
  conventionalSubjectLine,
  SUBJECT_SOFT_LIMIT,
  subjectMeterTone,
  SubjectMeterTone,
  type ConventionalFields,
} from "@/lib/conventionalCommit";
import { focusRing } from "@/lib/ui";

const METER_CLASS: Record<SubjectMeterTone, string> = {
  [SubjectMeterTone.Empty]: "text-neutral-300 dark:text-neutral-600",
  [SubjectMeterTone.Ok]: "text-[color:var(--accent)]",
  [SubjectMeterTone.Warn]: "font-semibold text-amber-500",
  [SubjectMeterTone.Over]: "font-semibold text-rose-500",
};

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 rounded-md px-2.5 transition-colors",
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300",
        focusRing,
      )}
    >
      {children}
    </button>
  );
}

export function CommitMessageEditor({
  mode,
  onModeChange,
  msg,
  onMsgChange,
  fields,
  onFieldsChange,
  amend,
  actions,
}: {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** The full message (free-form textarea value). */
  msg: string;
  onMsgChange: (msg: string) => void;
  /** The structured view of the same message (conventional style). */
  fields: ConventionalFields;
  onFieldsChange: (patch: Partial<ConventionalFields>) => void;
  amend: boolean;
  /** Right-aligned controls on the style-switch row (the Draft affordance). */
  actions?: ReactNode;
}) {
  const conventional = mode === ComposerMode.Conventional;
  // A parsed type outside the dropdown list (e.g. `build`) stays selectable so
  // editing other fields never rewrites it.
  const typeOptions: string[] =
    fields.type && !(COMMIT_TYPES as readonly string[]).includes(fields.type)
      ? [...COMMIT_TYPES, fields.type]
      : [...COMMIT_TYPES];
  const subjectLine = conventionalSubjectLine(fields);
  const meter = subjectMeterTone(subjectLine.length, fields.subject.trim().length > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-black/[0.06] p-0.5 text-[11.5px] font-medium dark:bg-white/[0.08]">
          <ModeTab active={!conventional} onClick={() => onModeChange(ComposerMode.Message)}>
            Message
          </ModeTab>
          <ModeTab active={conventional} onClick={() => onModeChange(ComposerMode.Conventional)}>
            Conventional
          </ModeTab>
        </div>
        <div className="ml-auto flex items-center">{actions}</div>
      </div>

      <div className="rounded-lg border border-black/10 transition-colors focus-within:border-[color:var(--accent)] dark:border-white/10">
        {conventional ? (
          <>
            <div className="flex h-10 items-center gap-1 border-b border-black/[0.06] px-2 dark:border-white/[0.06]">
              <Select
                aria-label="Commit type"
                value={fields.type}
                onChange={(event) => onFieldsChange({ type: event.target.value })}
                wrapperClassName="shrink-0"
                className={cn(
                  "h-7 cursor-pointer rounded-md pl-2 pr-6 font-mono text-[12.5px] font-semibold",
                  fields.type
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                    : "bg-black/[0.05] text-neutral-400 dark:bg-white/[0.07]",
                )}
              >
                <option value="" className="dark:bg-neutral-800">
                  type
                </option>
                {typeOptions.map((t) => (
                  <option key={t} value={t} className="dark:bg-neutral-800">
                    {t}
                  </option>
                ))}
              </Select>
              {fields.type && (
                <>
                  <span aria-hidden className="shrink-0 font-mono text-[13px] text-neutral-300 dark:text-neutral-600">
                    (
                  </span>
                  <input
                    aria-label="Commit scope"
                    value={fields.scope}
                    // Parens can't round-trip through `type(scope): subject`.
                    onChange={(event) => onFieldsChange({ scope: event.target.value.replace(/[()]/g, "") })}
                    placeholder="scope"
                    className="w-[64px] shrink-0 bg-transparent font-mono text-[13px] text-neutral-700 outline-none placeholder:text-neutral-300 dark:text-neutral-200 dark:placeholder:text-neutral-600"
                  />
                  <span aria-hidden className="shrink-0 font-mono text-[13px] text-neutral-300 dark:text-neutral-600">
                    ):
                  </span>
                </>
              )}
              <input
                aria-label="Commit summary"
                value={fields.subject}
                onChange={(event) => onFieldsChange({ subject: event.target.value })}
                placeholder="short summary"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
              />
              <span
                title={`Full subject line: ${subjectLine.length} characters. Aim for ${SUBJECT_SOFT_LIMIT}; git UIs truncate past 72.`}
                className={cn("shrink-0 pl-0.5 font-mono text-[11px] tabular-nums", METER_CLASS[meter])}
              >
                {subjectLine.length}/{SUBJECT_SOFT_LIMIT}
              </span>
            </div>
            <textarea
              aria-label="Commit body"
              value={fields.body}
              onChange={(event) => onFieldsChange({ body: event.target.value })}
              placeholder="Optional body — explain the why"
              rows={2}
              className="block w-full resize-y bg-transparent px-2.5 py-2 text-[12.5px] leading-relaxed text-neutral-600 outline-none placeholder:text-neutral-400 dark:text-neutral-300"
            />
          </>
        ) : (
          <textarea
            aria-label="Commit message"
            value={msg}
            onChange={(event) => onMsgChange(event.target.value)}
            placeholder={amend ? "Amended commit message" : "Commit message"}
            rows={3}
            className="block w-full resize-y bg-transparent px-2.5 py-2.5 text-[13px] leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          />
        )}
      </div>
    </div>
  );
}
