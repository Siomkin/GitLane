// The "prepare message for agent" flow. Local review notes are pinned to diff
// lines (see DiffBody's LineNotes) and collected here:
//   - ReviewNotesTray  — a floating pill that shows the note count and opens…
//   - AgentMessageDialog — a popup with an *editable* message composed from the
//     notes, which the user can Copy or push into the in-app terminal agent.
// Notes are session-only (never persisted); the composed text is the artefact.

import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { useTerminalAgents } from "../../store/terminalAgents";
import { useUi, type ReviewNote } from "../../store/ui";
import { selectEnabledAgents } from "../terminal/agents";

/** Notes ordered for a stable, readable message: by file, then line, then side. */
function ordered(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.side.localeCompare(b.side),
  );
}

/** Build the default agent message from the pinned review notes. */
export function composeAgentMessage(notes: ReviewNote[], branch?: string | null): string {
  if (notes.length === 0) return "";
  const where = branch ? ` on branch \`${branch}\`` : "";
  const intro = `Please address the following code review ${
    notes.length === 1 ? "comment" : "comments"
  }${where}.\n\nKeep the fix scoped to the review feedback, avoid unrelated edits, and run the relevant checks.`;
  const blocks = ordered(notes).map((n, i) => {
    const parts = [`${i + 1}. ${n.file} — line ${n.lineRef}`];
    parts.push(`   Feedback: ${n.body.trim()}`);
    return parts.join("\n");
  });
  return `${intro}\n\nReview ${notes.length === 1 ? "comment" : "comments"}:\n\n${blocks.join("\n\n")}\n`;
}

/** Floating pill (bottom-left, above the terminal) summarising pinned notes. */
export function ReviewNotesTray() {
  const notes = useUi((s) => s.reviewNotes);
  const agentMessageOpen = useUi((s) => s.agentMessageOpen);
  const openAgentMessage = useUi((s) => s.openAgentMessage);
  const clearReviewNotes = useUi((s) => s.clearReviewNotes);

  // Hide while the dialog is up (it supersedes the tray) or with nothing pinned.
  if (notes.length === 0 || agentMessageOpen) return null;

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-30">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-black/10 bg-white py-1.5 pl-1.5 pr-1.5 shadow-[0_12px_30px_-6px_rgba(0,0,0,0.3)] dark:border-white/10 dark:bg-neutral-800">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[#3b7ff5] text-[11px] font-semibold text-white">
          {notes.length}
        </span>
        <span className="text-[13px] text-neutral-600 dark:text-neutral-300">
          review {notes.length === 1 ? "note" : "notes"}
        </span>
        <button
          onClick={openAgentMessage}
          className="h-8 rounded-full bg-[#3b7ff5] px-3 text-[13px] font-medium text-white hover:brightness-110"
        >
          Prepare message for agent
        </button>
        <button
          onClick={() => clearReviewNotes()}
          title="Clear all notes"
          className="grid h-7 w-7 place-items-center rounded-full text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** The popup: an editable, pre-composed message with Copy / Open-in-terminal. */
export function AgentMessageDialog() {
  const open = useUi((s) => s.agentMessageOpen);
  const notes = useUi((s) => s.reviewNotes);
  const close = useUi((s) => s.closeAgentMessage);
  const sendToTerminal = useUi((s) => s.sendToTerminal);
  const showToast = useUi((s) => s.showToast);
  const branch = useRepo((s) => s.summary?.headBranch ?? null);
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const [text, setText] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = selectEnabledAgents(agentsRaw);
  const availableAgents = agents.filter((a) => a.available);
  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId && agent.available) ??
    availableAgents[0] ??
    null;

  // Compose once each time the popup opens; later edits are the user's to keep.
  useEffect(() => {
    if (open) setText(composeAgentMessage(notes, branch));
  }, [open, notes, branch]);

  useEffect(() => {
    if (!open) return;
    void loadAgents();
  }, [open, loadAgents]);

  useEffect(() => {
    if (!open) return;
    const selectedExists = selectedAgentId && agents.some((agent) => agent.id === selectedAgentId);
    const selectedAvailable =
      selectedAgentId && agents.some((agent) => agent.id === selectedAgentId && agent.available);
    if (selectedAvailable || (selectedExists && availableAgents.length === 0)) return;
    setSelectedAgentId(availableAgents[0]?.id ?? agents[0]?.id ?? null);
  }, [open, agents, availableAgents, selectedAgentId]);

  if (!open) return null;

  const empty = text.trim().length === 0;

  const copy = () => {
    if (empty) return;
    void navigator.clipboard?.writeText(text);
    showToast("Message copied");
    close();
  };
  const send = () => {
    if (empty || !selectedAgent) return;
    sendToTerminal(text, selectedAgent.command);
    showToast(`Opened ${selectedAgent.name} — press Enter to send`);
    close();
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-10 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-full rounded-2xl border border-black/10 bg-white p-5 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="text-[16px] font-semibold text-neutral-800 dark:text-neutral-100">
          Prepare message for agent
        </div>
        <div className="mt-0.5 text-[12px] text-neutral-400">
          {notes.length} {notes.length === 1 ? "note" : "notes"} · choose an agent and edit before sending
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-neutral-500 dark:text-neutral-400">
            Agent
          </span>
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                if (agent.available) setSelectedAgentId(agent.id);
              }}
              disabled={!agent.available}
              title={agent.available ? agent.command : `${agent.command} was not found on PATH`}
              className={cn(
                "h-8 rounded-lg px-2.5 font-mono text-[12px] font-medium transition",
                agent.available
                  ? selectedAgent?.id === agent.id
                    ? "bg-[var(--accent)] text-white shadow-sm"
                    : "border border-black/10 text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/10"
                  : "cursor-not-allowed border border-black/5 text-neutral-300 dark:border-white/5 dark:text-neutral-600",
                focusRing,
              )}
            >
              {agent.name}
            </button>
          ))}
          {agents.length === 0 && (
            <span className="text-[12px] text-amber-600 dark:text-amber-400">
              No enabled agents. Add one in Settings.
            </span>
          )}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          spellCheck={false}
          className="mt-3 h-64 w-full resize-none overflow-auto rounded-xl border border-black/10 bg-black/[0.02] p-3.5 font-mono text-[12.5px] leading-relaxed text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-200"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={close}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={copy}
            disabled={empty}
            className="h-9 rounded-lg border border-black/10 px-4 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            Copy
          </button>
          <button
            onClick={send}
            disabled={empty || !selectedAgent}
            className="h-9 rounded-lg bg-[#3b7ff5] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            Send to {selectedAgent?.name ?? "agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
