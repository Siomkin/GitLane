// The "hand to agent" message composer. Local review comments are pinned to diff
// line ranges (see the review/comments module); the docked HandToAgentBar opens
// this dialog — an *editable* message composed from the comments that the user
// can Copy or push into the in-app terminal agent. Comments are session-only
// (never persisted); the composed text is the artefact.

import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { basename } from "../../lib/paths";
import { focusRing } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { useTerminalAgents } from "../../store/terminalAgents";
import { useUi } from "../../store/ui";
import { CloseIcon, DiamondIcon } from "@/components/ui/icons";
import { composeAgentMessage, orderedNotes } from "../review/comments";
import { selectEnabledAgents } from "../terminal/agents";

/** The popup: an editable, pre-composed message with an agent picker + Copy /
 * Send-to-terminal. */
export function AgentMessageDialog() {
  const open = useUi((s) => s.agentMessageOpen);
  const notes = useUi((s) => s.reviewNotes);
  const removeReviewNote = useUi((s) => s.removeReviewNote);
  const close = useUi((s) => s.closeAgentMessage);
  const sendToTerminal = useUi((s) => s.sendToTerminal);
  const showToast = useUi((s) => s.showToast);
  const branch = useRepo((s) => s.summary?.headBranch ?? null);
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const [text, setText] = useState("");
  // Tracks whether the user has manually edited the composed message, so note
  // changes (e.g. removing one from the list) don't clobber their edits.
  const [dirty, setDirty] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = selectEnabledAgents(agentsRaw);
  const availableAgents = agents.filter((a) => a.available);
  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId && agent.available) ??
    availableAgents[0] ??
    null;

  // Recompose while the dialog is open and untouched — so opening fresh, or
  // removing a comment from the list, updates the message — but never overwrite
  // manual edits (the dialog explicitly asks the user to review/edit).
  useEffect(() => {
    if (open && !dirty) setText(composeAgentMessage(notes, branch));
  }, [open, dirty, notes, branch]);

  // Reset the edit flag when the dialog closes, so the next open composes fresh.
  useEffect(() => {
    if (!open) setDirty(false);
  }, [open]);

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
  const count = notes.length;
  const word = count === 1 ? "comment" : "comments";

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
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-10 backdrop-blur-sm dark:bg-black/55"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-full rounded-2xl border border-black/10 bg-white p-5 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="flex items-center gap-2">
          <DiamondIcon width={16} height={16} className="text-neutral-500" />
          <div className="text-[16px] font-semibold text-neutral-800 dark:text-neutral-100">
            Hand off to {selectedAgent?.name ?? "agent"}
          </div>
        </div>
        <div className="mt-0.5 text-[12px] text-neutral-400">
          {count} {word} · review &amp; edit before sending
        </div>
        {/* Every pending comment, removable here — including ones whose lines
         * vanished after a diff refresh (orphaned), which otherwise have no UI. */}
        <div className="mt-3 max-h-28 space-y-0.5 overflow-auto rounded-lg border border-black/5 p-1 dark:border-white/5">
          {orderedNotes(notes).map((n) => (
            <div
              key={n.id}
              className="group/note flex items-center gap-2 rounded px-1.5 py-0.5 text-[12px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <span className="flex-none font-mono text-[11px] text-neutral-400">
                {basename(n.file)}:{n.lineRef}
              </span>
              <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-300">{n.body}</span>
              <button
                type="button"
                onClick={() => removeReviewNote(n.id)}
                title="Remove comment"
                aria-label={`Remove comment on ${n.file}:${n.lineRef}`}
                className="flex-none rounded p-0.5 text-neutral-400 opacity-0 transition hover:text-rose-500 focus:opacity-100 group-hover/note:opacity-100"
              >
                <CloseIcon width={12} height={12} />
              </button>
            </div>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          spellCheck={false}
          className="mt-3 h-60 w-full resize-none overflow-auto rounded-xl border border-black/10 bg-black/[0.02] p-3.5 font-mono text-[12.5px] leading-relaxed text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-200"
        />
        <div className="mt-3 flex items-center gap-2">
          {agents.length > 0 ? (
            <div className="mr-auto flex rounded-lg bg-black/[0.06] p-0.5 text-[12.5px] dark:bg-white/[0.06]">
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
                    "h-8 rounded-md px-3 font-mono font-medium transition",
                    agent.available
                      ? selectedAgent?.id === agent.id
                        ? "bg-[color:var(--accent)] text-white shadow-sm"
                        : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                      : "cursor-not-allowed text-neutral-300 dark:text-neutral-600",
                    focusRing,
                  )}
                >
                  {agent.name}
                </button>
              ))}
            </div>
          ) : (
            <span className="mr-auto text-[12px] text-amber-600 dark:text-amber-400">
              No enabled agents. Add one in Settings.
            </span>
          )}
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
            className="h-9 rounded-lg bg-[color:var(--accent)] px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-45"
          >
            Send to {selectedAgent?.name ?? "agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
