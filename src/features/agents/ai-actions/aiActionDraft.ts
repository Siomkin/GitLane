// Pure list transforms for the Prompts → AI actions editor. The Settings draft
// is a local copy of `messages.aiActions`; each edit persists the whole blob.

import type { AiActionCommand } from "@/lib/api";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "@/store/commitAgentMessages";

// Derived from the defaults, so a new built-in is recognised the moment it is
// added there — never a hand-kept third copy of the list.
const BUILTIN_AI_ACTION_IDS: readonly string[] = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.map(
  (command) => command.id,
);

export function isBuiltinAiAction(id: string): boolean {
  return BUILTIN_AI_ACTION_IDS.includes(id);
}

export function blankAiActionCommand(): AiActionCommand {
  return { id: crypto.randomUUID(), title: "", instruction: "", enabled: true };
}

export function updateAiActionCommand(
  list: AiActionCommand[],
  id: string,
  patch: Partial<AiActionCommand>,
): AiActionCommand[] {
  return list.map((command) => (command.id === id ? { ...command, ...patch } : command));
}

export function removeAiActionCommand(list: AiActionCommand[], id: string): AiActionCommand[] {
  if (isBuiltinAiAction(id)) return list;
  return list.filter((command) => command.id !== id);
}

export function moveAiActionCommand(
  list: AiActionCommand[],
  from: number,
  to: number,
): AiActionCommand[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Restore a builtin's shipped title and prompt; keep the enabled flag. */
export function resetBuiltinAiAction(list: AiActionCommand[], id: string): AiActionCommand[] {
  const shipped = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.find((command) => command.id === id);
  if (!shipped) return list;
  return list.map((command) =>
    command.id === id ? { ...shipped, enabled: command.enabled } : command,
  );
}

export function trimAiActions(list: AiActionCommand[]): AiActionCommand[] {
  return list.map((command) => ({
    ...command,
    title: command.title.trim(),
    instruction: command.instruction.trim(),
  }));
}

/** Drop unfinished user rows and disable incomplete ones so a partial draft can
 *  still be written. Builtins always stay in the list. */
export function persistableAiActions(list: AiActionCommand[]): AiActionCommand[] {
  return trimAiActions(list)
    .filter((command) => isBuiltinAiAction(command.id) || command.title !== "" || command.instruction !== "")
    .map((command) => ({
      ...command,
      enabled: command.enabled && command.title !== "" && command.instruction !== "",
    }));
}
