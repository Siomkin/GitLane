// One Prompts row: compact by default, expands to edit. AI-action commands can
// be reordered, disabled, and (if user-added) deleted. The commit-message row
// uses the same shell without those controls — it is always on.
// Drag lives on the list container via `useListReorder`.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { AiActionCommand } from "@/lib/api";
import { isBuiltinAiAction } from "./aiActionDraft";
import {
  DeleteGlyph,
  DragHandle,
  EditGlyph,
  EnableSwitch,
  RowIconButton,
} from "@/features/terminal/agentRowParts";

export function AiActionCommandRow({
  command,
  editing,
  dragging = false,
  disabled,
  pinned = false,
  registerEl,
  onHandleDown,
  onEdit,
  onSave,
  onCancel,
  onToggleEnabled,
  onTitle,
  onInstruction,
  onReset,
  onDelete,
  dirty = false,
  resetDisabled = false,
}: {
  command: AiActionCommand;
  editing: boolean;
  dragging?: boolean;
  disabled: boolean;
  /** Commit-message row: same editor, no drag / enable / delete. */
  pinned?: boolean;
  registerEl?: (el: HTMLElement | null) => void;
  onHandleDown?: (e: React.PointerEvent) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onToggleEnabled?: () => void;
  onTitle?: (value: string) => void;
  onInstruction: (value: string) => void;
  onReset?: () => void;
  onDelete?: () => void;
  dirty?: boolean;
  resetDisabled?: boolean;
}) {
  const builtin = pinned || isBuiltinAiAction(command.id);
  const label = command.title.trim() || "Untitled command";
  const dim = !editing && !pinned && !command.enabled;
  const incomplete = (pinned || command.enabled) && (!command.title.trim() || !command.instruction.trim());
  const saveDisabled = disabled || incomplete || !dirty;
  const gutter = pinned ? "" : "pl-[60px]";

  return (
    <div
      ref={registerEl}
      style={
        dragging
          ? { opacity: 0.95, boxShadow: "0 18px 40px -12px rgba(0,0,0,0.4)", position: "relative", zIndex: 20 }
          : undefined
      }
      className={cn(
        "rounded-xl border transition-colors",
        dragging
          ? "border-[var(--accent)]/60 bg-white dark:bg-neutral-800"
          : editing
            ? "border-black/[0.1] bg-white shadow-sm dark:border-white/[0.12] dark:bg-neutral-800/70"
            : "border-black/[0.05] hover:border-black/[0.11] hover:bg-white dark:border-white/[0.06] dark:hover:border-white/[0.12] dark:hover:bg-neutral-800/40",
        dim && "opacity-55",
      )}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-2.5">
          <div className="flex items-center gap-2">
            {!pinned && onHandleDown && <DragHandle label={label} onPointerDown={onHandleDown} tall />}
            {!pinned && onToggleEnabled && (
              <EnableSwitch
                enabled={command.enabled}
                label={label}
                title={command.enabled ? "Shown in the AI actions popup" : "Hidden from the AI actions popup"}
                onClick={onToggleEnabled}
              />
            )}
            {pinned || !onTitle ? (
              <span className="min-w-0 flex-1 truncate px-1.5 text-[13.5px] font-semibold text-neutral-900 dark:text-white">
                {label}
              </span>
            ) : (
              <input
                value={command.title}
                onChange={(event) => onTitle(event.target.value)}
                placeholder="Title"
                aria-label="Command title"
                disabled={disabled}
                spellCheck={false}
                className={cn(
                  "h-9 min-w-0 flex-1 rounded-lg border bg-black/[0.02] px-2.5 text-[13.5px] font-semibold text-neutral-900 outline-none focus:border-[var(--accent)] focus:bg-white dark:bg-white/[0.04] dark:text-white dark:focus:bg-neutral-800",
                  command.title.trim() ? "border-transparent" : "border-rose-400/70",
                  focusRing,
                )}
              />
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {onReset && (
                <button
                  type="button"
                  aria-label={`Reset ${label}`}
                  disabled={disabled || resetDisabled}
                  onClick={onReset}
                  className={cn(
                    "rounded-md px-2 py-1 text-[11.5px] font-semibold text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 disabled:cursor-default disabled:opacity-35 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
                    focusRing,
                  )}
                >
                  Reset to default
                </button>
              )}
              {onDelete && !builtin && (
                <RowIconButton label={`Delete ${label}`} title="Delete" onClick={onDelete} danger>
                  <DeleteGlyph />
                </RowIconButton>
              )}
            </div>
          </div>
          <div className={gutter}>
            <textarea
              value={command.instruction}
              onChange={(event) => onInstruction(event.target.value)}
              placeholder="Prompt sent to the agent"
              aria-label={`Prompt for ${label}`}
              disabled={disabled}
              className={cn(
                "min-h-20 w-full resize-y rounded-lg border border-black/10 bg-white px-3 py-2.5 text-[12.5px] font-normal leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100",
                focusRing,
              )}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                aria-label={`Cancel ${label}`}
                onClick={onCancel}
                className={cn(
                  "h-8 shrink-0 rounded-lg px-3.5 text-[12.5px] font-semibold text-neutral-500 transition hover:bg-black/[0.05] hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
                  focusRing,
                )}
              >
                Cancel
              </button>
              <button
                type="button"
                aria-label={`Save ${label}`}
                disabled={saveDisabled}
                onClick={onSave}
                className={cn(
                  "h-8 shrink-0 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-default disabled:opacity-45 disabled:hover:brightness-100 disabled:active:scale-100",
                  focusRing,
                )}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="group/row flex h-[46px] items-center gap-2 pl-1 pr-2">
          {!pinned && onHandleDown && <DragHandle label={label} onPointerDown={onHandleDown} revealOnHover />}
          {!pinned && onToggleEnabled && (
            <EnableSwitch
              enabled={command.enabled}
              label={label}
              title={command.enabled ? "Shown in the AI actions popup" : "Hidden from the AI actions popup"}
              onClick={onToggleEnabled}
            />
          )}
          <button
            type="button"
            onClick={onEdit}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
          >
            <span
              className={cn(
                "min-w-0 truncate text-[14px] font-semibold",
                command.title.trim()
                  ? "text-neutral-900 dark:text-white"
                  : "italic text-neutral-400 dark:text-neutral-500",
              )}
            >
              {command.title.trim() || "Untitled command"}
            </span>
          </button>
          {incomplete && (
            <span
              role="img"
              aria-label="Incomplete command — title and prompt are required"
              title="Title and prompt are required"
              className="grid h-4 w-4 shrink-0 place-items-center text-amber-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} className="h-3.5 w-3.5">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
            </span>
          )}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            <RowIconButton label={`Edit ${label}`} title="Edit" onClick={onEdit}>
              <EditGlyph />
            </RowIconButton>
            {onDelete && !builtin && (
              <RowIconButton label={`Delete ${label}`} title="Delete" onClick={onDelete} danger>
                <DeleteGlyph />
              </RowIconButton>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
