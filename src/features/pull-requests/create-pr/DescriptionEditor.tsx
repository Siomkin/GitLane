// Title + description: Write/Preview over the same sanitized markdown renderer
// the PR conversation uses, with two ways to seed the body — the repository's
// templates and the range's own commit subjects — and one undo covering both.

import { useState } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/cn";
import { DESCRIPTION_TAB, type DescriptionTab } from "./useCreatePrForm";
import type { PrTemplateRef } from "./prTemplates";

export function DescriptionEditor({
  body,
  onBody,
  tab,
  onTab,
  templates,
  onTemplate,
  onFromCommits,
  canFillFromCommits,
  canRestore,
  onRestore,
}: {
  body: string;
  onBody: (value: string) => void;
  tab: DescriptionTab;
  onTab: (tab: DescriptionTab) => void;
  templates: PrTemplateRef[];
  onTemplate: (template: PrTemplateRef) => void;
  onFromCommits: () => void;
  /** False when the range read found no commits — nothing to summarise. */
  canFillFromCommits: boolean;
  canRestore: boolean;
  onRestore: () => void;
}) {
  const [templatesOpen, setTemplatesOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
      <div className="flex h-9 items-center gap-1 border-b border-black/5 bg-black/[0.02] px-2 dark:border-white/5 dark:bg-white/[0.03]">
        <TabButton
          active={tab === DESCRIPTION_TAB.Write}
          onClick={() => onTab(DESCRIPTION_TAB.Write)}
        >
          Write
        </TabButton>
        <TabButton
          active={tab === DESCRIPTION_TAB.Preview}
          onClick={() => onTab(DESCRIPTION_TAB.Preview)}
        >
          Preview
        </TabButton>
        <div className="ml-auto flex items-center gap-1.5 pr-0.5">
          {canRestore && (
            <ToolButton onClick={onRestore}>Restore my draft</ToolButton>
          )}
          <ToolButton
            onClick={onFromCommits}
            disabled={!canFillFromCommits}
            title="Fill the description from this range's commit subjects"
          >
            From commits
          </ToolButton>
          {templates.length > 0 && (
            <ToolButton
              onClick={() => setTemplatesOpen((open) => !open)}
              active={templatesOpen}
              aria-expanded={templatesOpen}
            >
              Template
            </ToolButton>
          )}
        </div>
      </div>

      {templatesOpen && (
        <div className="border-b border-black/5 bg-black/[0.015] p-1.5 dark:border-white/5 dark:bg-white/[0.02]">
          <div className="px-1.5 pb-1 pt-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-400">
            Start from a template
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.path}
                type="button"
                onClick={() => {
                  onTemplate(template);
                  setTemplatesOpen(false);
                }}
                className="flex flex-col items-start gap-0.5 rounded-lg border border-black/10 px-2.5 py-2 transition-colors hover:border-black/25 dark:border-white/10 dark:hover:border-white/25"
              >
                <span className="whitespace-nowrap font-mono text-[12px] text-neutral-800 dark:text-neutral-100">
                  {template.file}
                </span>
                <span className="text-left text-[11.5px] leading-snug text-neutral-400">
                  {template.note}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === DESCRIPTION_TAB.Write ? (
        <textarea
          aria-label="Description"
          value={body}
          onChange={(e) => onBody(e.target.value)}
          placeholder="Describe your changes… (Markdown supported)"
          className="h-[150px] w-full resize-none bg-transparent p-3.5 text-[13.5px] leading-relaxed text-neutral-800 outline-none dark:text-neutral-100"
        />
      ) : (
        <div className="h-[150px] overflow-auto p-3.5">
          <Markdown content={body} />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
    >
      {children}
    </button>
  );
}

function ToolButton({
  onClick,
  disabled,
  active,
  title,
  children,
  ...rest
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-7 whitespace-nowrap rounded-md px-2 text-[12px] transition-colors disabled:opacity-40",
        active
          ? "bg-black/[0.07] text-neutral-700 dark:bg-white/10 dark:text-neutral-200"
          : "text-neutral-500 hover:bg-black/[0.05] dark:text-neutral-400 dark:hover:bg-white/[0.06]",
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
