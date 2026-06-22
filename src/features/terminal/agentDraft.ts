// Pure terminal-agent draft transforms — no React, no IPC. The Settings editor
// keeps the user's in-progress edits in a local `draft` list and commits it to
// the backend on Save; every transform here is a list-in / list-out function so
// the CRUD + reorder logic stays testable outside the render tree.

import type { TerminalAgent } from "@/lib/api";

/** Per-row live PATH-check state for the manual "Check" button. */
export type CheckStatus = "checking" | "found" | "missing";
export interface AgentCheck {
  command: string;
  status: CheckStatus;
}
export type PreviewAvailability = "available" | "missing" | "unchecked";

/** Compact signature of the editable fields (id, name, command, description,
 *  enabled) — ignores `available`, which the backend recomputes on save. Used
 *  for dirty detection so an availability refresh doesn't read as a pending
 *  edit. */
export function agentSignature(list: TerminalAgent[]): string {
  return JSON.stringify(
    list.map(({ id, name, command, description, enabled }) => ({
      id,
      name,
      command,
      description,
      enabled,
    })),
  );
}

/** First whitespace-delimited token of a command — the executable name. */
export function bin(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/** An agent is usable once it has both a name and a command. */
export function isAgentValid(agent: TerminalAgent): boolean {
  return agent.name.trim() !== "" && agent.command.trim() !== "";
}

/** The Save button is enabled only when every drafted agent is valid. */
export function areAgentsValid(list: TerminalAgent[]): boolean {
  return list.every(isAgentValid);
}

/** Has the draft diverged from the last-saved list (ignoring availability)? */
export function isDraftDirty(draft: TerminalAgent[], saved: TerminalAgent[]): boolean {
  return agentSignature(draft) !== agentSignature(saved);
}

/** A fresh, empty agent row (enabled, awaiting a name + command). */
export function blankAgent(): TerminalAgent {
  return {
    id: crypto.randomUUID(),
    name: "",
    command: "",
    description: "",
    enabled: true,
    available: false,
  };
}

/** Append a new blank agent. */
export function addAgent(list: TerminalAgent[]): TerminalAgent[] {
  return [...list, blankAgent()];
}

/** Patch one agent's editable fields by id (no-op if the id is gone). */
export function updateAgent(
  list: TerminalAgent[],
  id: string,
  patch: Partial<TerminalAgent>,
): TerminalAgent[] {
  return list.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

/** Insert a copy of an agent (fresh id, " copy" suffix) right after it. */
export function duplicateAgent(list: TerminalAgent[], id: string): TerminalAgent[] {
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return list;
  const src = list[i];
  const copy: TerminalAgent = {
    ...src,
    id: crypto.randomUUID(),
    name: src.name.trim() ? `${src.name} copy` : src.name,
    available: false,
  };
  const next = [...list];
  next.splice(i + 1, 0, copy);
  return next;
}

/** Drop an agent by id. */
export function removeAgent(list: TerminalAgent[], id: string): TerminalAgent[] {
  return list.filter((a) => a.id !== id);
}

/** Move the agent at `from` to index `to` (clamped/ignored when out of range). */
export function moveAgent(list: TerminalAgent[], from: number, to: number): TerminalAgent[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Resolve what the preview can truthfully say about a draft command. A saved,
 * unchanged command can reuse the backend-probed value; an edited/new command
 * stays visibly unchecked until the user runs the live Check action. */
export function previewAvailability(
  agent: TerminalAgent,
  saved: TerminalAgent | undefined,
  check: AgentCheck | undefined,
): PreviewAvailability {
  if (check?.command === agent.command) {
    if (check.status === "found") return "available";
    if (check.status === "missing") return "missing";
    return "unchecked";
  }
  if (saved?.command === agent.command) return saved.available ? "available" : "missing";
  return "unchecked";
}
