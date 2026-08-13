import { CheckIcon, ChevronDownIcon, ListIcon } from "@/components/ui/icons";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { ShortcutId, shortcutParts } from "@/lib/shortcuts";
import { focusRing } from "@/lib/ui";
import { extraPlaceholder, type AiActionDef, type AiActionId } from "./aiActions";
import { AiActionMenu, type AiActionMenu as Menu } from "./aiActionsView";
import { AiActionsMenu } from "./AiActionsMenu";
import { AiActionPhase, type AiActionPhase as Phase } from "./useAiActionRun";

export function AiActionsToolbar({
  action,
  actions,
  def,
  extra,
  jiraKey,
  streaming,
  phase,
  canRun,
  menu,
  onToggleMenu,
  onPickAction,
  onExtra,
  onRunOrStop,
}: {
  action: AiActionId;
  actions: AiActionDef[];
  def: AiActionDef;
  extra: string;
  jiraKey: string | null;
  streaming: boolean;
  phase: Phase;
  canRun: boolean;
  menu: Menu;
  onToggleMenu: (next: Menu) => void;
  onPickAction: (id: AiActionId) => void;
  onExtra: (value: string) => void;
  onRunOrStop: () => void;
}) {
  return (
    <div className="relative flex shrink-0 items-center gap-2 border-b border-black/[0.07] bg-black/[0.02] px-4 py-2.5 dark:border-white/[0.07] dark:bg-black/20">
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => onToggleMenu(menu === AiActionMenu.Action ? AiActionMenu.None : AiActionMenu.Action)}
          className={cn(
            "flex h-9 items-center gap-2 rounded-lg border border-black/10 pl-3 pr-2.5 text-[13px] font-medium text-neutral-800 dark:border-white/[0.12] dark:text-neutral-100",
            menu === AiActionMenu.Action
              ? "bg-black/[0.06] dark:bg-white/[0.1]"
              : "bg-black/[0.03] hover:bg-black/[0.05] dark:bg-white/[0.05] dark:hover:bg-white/[0.09]",
            focusRing,
          )}
        >
          <span className="whitespace-nowrap">{def.label}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 text-neutral-400" />
        </button>
        {menu === AiActionMenu.Action && (
          <AiActionsMenu width="w-[268px]">
            {actions.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onPickAction(row.id)}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px]",
                  row.id === action
                    ? "bg-black/[0.05] font-medium text-neutral-800 dark:bg-white/[0.06] dark:text-white"
                    : "text-neutral-600 hover:bg-black/[0.04] dark:text-neutral-300 dark:hover:bg-white/[0.06] dark:hover:text-white",
                  focusRing,
                )}
              >
                <span className="flex-1 text-left whitespace-nowrap">{row.label}</span>
                {row.id === action && <CheckIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" />}
              </button>
            ))}
          </AiActionsMenu>
        )}
      </div>
      <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-black/10 bg-white px-3 focus-within:border-[color:var(--accent)] dark:border-white/[0.09] dark:bg-white/[0.03]">
        <span className="shrink-0 text-neutral-500" aria-hidden>
          <ListIcon className="h-4 w-4" />
        </span>
        <input
          value={extra}
          onChange={(e) => onExtra(e.target.value)}
          placeholder={extraPlaceholder(action, def.label)}
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-neutral-800 outline-none dark:text-neutral-100"
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {jiraKey && (
          <span className="shrink-0 whitespace-nowrap text-[12px] text-neutral-500">
            <span className="font-mono text-neutral-700 dark:text-neutral-300">{jiraKey}</span> from branch
          </span>
        )}
        <button
          type="button"
          onClick={onRunOrStop}
          disabled={!streaming && !canRun}
          className={cn(
            "flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-4 text-[13px] font-semibold text-white transition active:scale-[0.97] hover:brightness-110 disabled:opacity-45",
            streaming ? "bg-neutral-500 dark:bg-neutral-600" : "bg-[var(--accent)]",
            focusRing,
          )}
        >
          {streaming && <span className="h-2.5 w-2.5 rounded-[2px] bg-white" />}
          <span>{streaming ? "Stop" : phase === AiActionPhase.Done ? "Regenerate" : "Run"}</span>
          {!streaming && (
            <ShortcutHint keys={shortcutParts(ShortcutId.SubmitForm, isMac)} tone="onAccent" />
          )}
        </button>
      </div>
    </div>
  );
}
