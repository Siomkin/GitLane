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
  activeTabId: string | null;
  /** Whether the active tab's PTY is running (injections wait for it). */
  alive: boolean;
  /** The active repo's identity path — injection ownership is checked first. */
  repoKey: string | null;
}

export function useTerminalInjection({
  controller,
  activeTabId,
  alive,
  repoKey,
}: TerminalInjectionInputs): void {
  const terminalInject = useUi((s) => s.terminalInject);
  const clearTerminalInject = useUi((s) => s.clearTerminalInject);
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
    if (!alive || !activeTabId) return;
    const pane = controller.get(activeTabId);
    if (!pane || pane.sessionId == null) return;
    const { view } = pane;
    let cancelled = false;
    let timer: number | undefined;
    const paste = () => {
      if (cancelled) return;
      view.paste(terminalInject.text);
      view.term.focus();
      clearTerminalInject();
    };
    if (terminalInject.command) {
      void controller.write(activeTabId, new TextEncoder().encode(`${terminalInject.command}\n`)).then((ok) => {
        if (cancelled) return;
        // The launch write failed (surfaced in the terminal) — keep the
        // injection queued instead of dropping the text on the floor (GL-176).
        if (!ok) return;
        const startedAt = Date.now();
        const waitForPrompt = () => {
          if (cancelled) return;
          if (view.bracketedPaste() || Date.now() - startedAt > 4000) {
            paste();
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
  }, [terminalInject, alive, activeTabId, clearTerminalInject, controller, repoKey]);
}
