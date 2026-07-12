// The "hand to agent" message composer. Local review comments are pinned to diff
// line ranges (see the review/comments module); the docked HandToAgentBar opens
// this dialog — an *editable* message composed from the comments that the user
// can Copy or push into the in-app terminal agent. Comments are session-only
// (never persisted); the composed text is the artefact.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { basename } from "@/lib/paths";
import { focusRing } from "@/lib/ui";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { CloseIcon, DiamondIcon } from "@/components/ui/icons";
import { composeAgentMessage, orderedNotes } from "@/features/review/comments/notes";
import { selectEnabledAgents } from "@/features/terminal/agents";
import { Select } from "@/components/ui/Select";

/** The popup: an editable, pre-composed message with an agent picker + Copy /
 * Send-to-terminal. */
export function AgentMessageDialog() {
  const open = useUi((s) => s.agentMessageOpen);
  const surfaces = useUi((s) => s.agentMessageSurfaces);
  const branch = useUi((s) => s.agentMessageBranch);
  const allNotes = useUi((s) => s.reviewNotes);
  const removeReviewNote = useUi((s) => s.removeReviewNote);
  const close = useUi((s) => s.closeAgentMessage);
  const sendToTerminal = useUi((s) => s.sendToTerminal);
  const showToast = useUi((s) => s.showToast);
  // Only the comments from the surface(s) that opened the dialog are handed off.
  const surfaceSet = useMemo(() => new Set(surfaces), [surfaces]);
  const notes = useMemo(
    () => allNotes.filter((n) => surfaceSet.has(n.surface)),
    [allNotes, surfaceSet],
  );
  const agentsRaw = useTerminalAgents((s) => s.agents);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const [draft, setDraft] = useState("");
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
  const composedText = useMemo(() => composeAgentMessage(notes, branch), [notes, branch]);
  const text = dirty ? draft : composedText;

  useEffect(() => {
    if (!open) return;
    void loadAgents();
  }, [open, loadAgents]);

  if (!open) return null;

  const empty = text.trim().length === 0;
  const count = notes.length;
  const word = count === 1 ? "comment" : "comments";
  const modelSelectId = "agent-message-model";

  const dismiss = () => {
    setDraft("");
    setDirty(false);
    close();
  };

  const copy = () => {
    if (empty) return;
    void navigator.clipboard?.writeText(text);
    showToast("Message copied");
    dismiss();
  };
  const send = () => {
    if (empty || !selectedAgent) return;
    sendToTerminal(text, selectedAgent.command);
    dismiss();
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-10">
      <button
        type="button"
        aria-label="Close handoff dialog"
        onClick={dismiss}
        className="absolute inset-0 bg-black/30 backdrop-blur-sm dark:bg-black/55"
      />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-[560px] max-w-full rounded-2xl border border-black/10 bg-white p-5 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
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
          aria-label="Agent handoff message"
          value={text}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") dismiss();
          }}
          spellCheck={false}
          className="mt-3 h-60 w-full resize-none overflow-auto rounded-xl border border-black/10 bg-black/[0.02] p-3.5 font-mono text-[12.5px] leading-relaxed text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-200"
        />
        <div className="mt-3 flex items-center gap-2">
          {agents.length > 0 ? (
            <label className="mr-auto flex min-w-0 items-center gap-2 text-[12px] text-neutral-500 dark:text-neutral-400">
              <span id={`${modelSelectId}-label`}>Model</span>
              <Select
                id={modelSelectId}
                aria-labelledby={`${modelSelectId}-label`}
                value={selectedAgent?.id ?? ""}
                onChange={(e) => setSelectedAgentId(e.target.value || null)}
                disabled={availableAgents.length === 0}
                className={cn(
                  "h-9 max-w-[220px] rounded-lg border border-black/10 bg-white pl-3 text-[13px] font-medium text-neutral-700 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-200",
                  focusRing,
                )}
              >
                {availableAgents.length === 0 && (
                  <option value="" disabled>
                    No available agents
                  </option>
                )}
                {agents.map((agent) => (
                  <option
                    key={agent.id}
                    value={agent.id}
                    disabled={!agent.available}
                    title={agent.available ? agent.command : `${agent.command} was not found on PATH`}
                  >
                    {agent.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <span className="mr-auto text-[12px] text-amber-600 dark:text-amber-400">
              No enabled agents. Add one in Settings.
            </span>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={empty}
            className="h-9 rounded-lg border border-black/10 px-4 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={send}
            disabled={empty || !selectedAgent}
            className="h-9 rounded-lg bg-[color:var(--accent)] px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-45"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
