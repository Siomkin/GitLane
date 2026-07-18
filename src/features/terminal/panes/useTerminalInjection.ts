// The "open in terminal" paste queue (GL-177): delivers a queued injection to
// the active pane, optionally launching an agent first and waiting for its
// prompt before pasting. Uses xterm's paste path (it only brackets when the
// foreground program has requested bracketed-paste mode). Owns the `ui` store's
// `terminalInject` slot — nothing else reads it.

import { useEffect } from "react";
import { useUi } from "@/store/ui";
import type { PaneController } from "./paneController";

export interface TerminalInjectionInputs {
  controller: PaneController;
  /** The active repo's identity path — injection ownership is checked first. */
  repoKey: string | null;
}

export function useTerminalInjection({
  controller,
  repoKey,
}: TerminalInjectionInputs): void {
  const terminalInject = useUi((s) => s.terminalInject);
  const clearTerminalInject = useUi((s) => s.clearTerminalInject);
  const cancelAgentCommitDraft = useUi((s) => s.cancelAgentCommitDraft);
  const showToast = useUi((s) => s.showToast);
  const targetTabId = terminalInject?.tabId ?? null;
  const targetAlive = targetTabId ? (controller.get(targetTabId)?.alive ?? false) : false;
  useEffect(() => {
    if (!terminalInject) return;
    // An injection belongs to the repo whose flow queued it: if another repo is
    // active by the time it could deliver (queued while dead, repo switched
    // after a failed launch, …), discard it rather than pasting into a
    // different repo's shell (GL-176 review). Runs before the alive gate so a
    // stale injection dies immediately, not on the next repo's spawn.
    if (terminalInject.repoKey !== repoKey) {
      clearTerminalInject();
      return;
    }
    if (!targetAlive || !targetTabId) return;
    const pane = controller.get(targetTabId);
    if (!pane || pane.sessionId == null) return;
    const { view } = pane;
    let cancelled = false;
    let timer: number | undefined;
    const bracketedBeforeLaunch = view.bracketedPaste();
    const paste = () => {
      if (cancelled) return;
      view.paste(terminalInject.text);
      view.term.focus();
      clearTerminalInject();
    };
    if (terminalInject.command) {
      // Submit with a carriage return, not a bare LF: that is what the Enter
      // key actually sends, and it is required on Windows ConPTY (cmd.exe /
      // PowerShell) where a lone `\n` does not submit the line — the agent
      // command would be typed but never executed, then the prompt would paste
      // onto the same line ("codexReview the staged changes…"). Unix PTYs map
      // CR->LF via the ICRNL line discipline, so `\r` works there too.
      void controller.write(targetTabId, new TextEncoder().encode(`${terminalInject.command}\r`)).then((ok) => {
        if (cancelled) return;
        // The launch write failed (surfaced in the terminal) — keep the
        // injection queued instead of dropping the text on the floor (GL-176).
        if (!ok) return;
        const startedAt = Date.now();
        // Interactive shells such as zsh can already have bracketed paste
        // enabled at their prompt. That pre-launch mode is not evidence that
        // the agent is ready: accepting it pasted the message while `codex`
        // was still starting, and the TUI redraw then discarded the input.
        // If it was already enabled, require a post-launch off -> on
        // transition. Agents that do not expose such a transition still use
        // the bounded fallback below.
        let sawBracketedOff = !bracketedBeforeLaunch;
        // Bracketed paste alone is NOT readiness: agents like codex enable it
        // within ~500 ms of launch, while still booting, and silently discard
        // input that arrives before their composer is up. What actually marks
        // a TUI as ready for input is that it has STOPPED drawing — so beyond
        // the bracketed-paste gate, require the PTY output to have been quiet
        // for a beat. On macOS/Linux the zsh off -> on transition already
        // fires at the right moment and the quiescence check adds a small
        // safety margin; on Windows (cmd.exe never pre-enables the mode, and
        // the on-transition comes far too early) quiescence is the signal
        // that makes the paste land instead of vanishing into codex's boot.
        const QUIET_MS = 600;
        const waitForPrompt = () => {
          if (cancelled) return;
          const bracketed = view.bracketedPaste();
          if (!bracketed) sawBracketedOff = true;
          // Ignore pre-launch timestamps: an idle shell's last prompt must not
          // count as "already quiet" before the agent has produced any output.
          const quiet = Date.now() - Math.max(pane.lastOutputAt, startedAt) >= QUIET_MS;
          // Only deliver after the foreground program explicitly asks for
          // bracketed paste. Falling back to a raw multiline paste is unsafe:
          // if the agent exited, the repository-derived prompt would land in
          // the shell and its newline-delimited lines could execute as commands.
          if (sawBracketedOff && bracketed && quiet) {
            paste();
            return;
          }
          if (Date.now() - startedAt > 8000) {
            view.term.writeln(
              "\x1b[33m[agent prompt not detected — queued text was not pasted]\x1b[0m",
            );
            if (
              terminalInject.draftToken &&
              useUi.getState().agentCommitDraft?.token === terminalInject.draftToken
            ) {
              cancelAgentCommitDraft();
            }
            clearTerminalInject();
            showToast(
              "GitLane did not paste the queued text because the agent prompt could not be verified.",
              "error",
            );
            return;
          }
          timer = window.setTimeout(waitForPrompt, 100);
        };
        timer = window.setTimeout(waitForPrompt, 500);
      });
    } else {
      paste();
    }
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [
    terminalInject,
    targetAlive,
    targetTabId,
    cancelAgentCommitDraft,
    clearTerminalInject,
    controller,
    repoKey,
    showToast,
  ]);
}
