// One terminal-agent row. Owns only the shared card shell (border / drag lift /
// dimming) and dispatches to the compact `AgentRowView` or the expanded
// `AgentRowEditor` by the `editing` flag. All draft state and orchestration live
// in `useTerminalAgentDraft`; drag is pointer-driven from the list container.

import { cn } from "../../lib/cn";
import type { TerminalAgent } from "../../lib/api";
import type { CheckStatus } from "./agentDraft";
import { AgentRowView } from "./AgentRowView";
import { AgentRowEditor } from "./AgentRowEditor";

export interface AgentRowProps {
  agent: TerminalAgent;
  /** Expanded into the editor (`AgentRowEditor`) vs compact (`AgentRowView`). */
  editing: boolean;
  check: CheckStatus | "idle";
  /** Lifted out of the list flow while this row is being dragged. */
  dragging: boolean;
  /** Registers the card element for rect measurement (drag) + FLIP reorder. */
  registerEl: (el: HTMLElement | null) => void;
  /** Pointer-down on the grip starts a drag (handled by the list container). */
  onHandleDown: (e: React.PointerEvent) => void;
  /** Expand this row into its editor. */
  onEdit: () => void;
  /** Collapse this row back to its compact view. */
  onDone: () => void;
  onToggleEnabled: () => void;
  onNameChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCheck: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function AgentRow(props: AgentRowProps) {
  const { agent, editing, dragging, registerEl } = props;
  // A disabled agent is dimmed only while collapsed — the editor stays legible.
  const dim = !editing && !agent.enabled;

  return (
    <div
      ref={registerEl}
      data-agent-card
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
      {editing ? <AgentRowEditor {...props} /> : <AgentRowView {...props} />}
    </div>
  );
}
