// The in-app integrated terminal: xterm.js emulators wired to Rust PTYs.
//
// Each terminal tab runs its own PTY (the user's login shell, cwd = a repo), and
// tabs are kept per repo — switching repos or tabs just shows a different live
// pane, so no shell or scrollback is ever reset. Output streams back via the
// `pty-data` Tauri event; keystrokes go out through `ptyWrite`. Agent buttons
// (opencode/kimi/claude/codex) type their command into the active tab's shell —
// they're not separate processes, so the user keeps full interactive control and
// the agent inherits the repo's environment.
//
// Rendered as a floating popup at the bottom of the window. App keeps this layer
// mounted for the whole app session. The xterm body (`TerminalBody`, a lazy
// chunk with xterm and its stylesheets) mounts on the first open and then stays
// mounted across repo open/close/switch and hide/collapse (just visually gone),
// so every pane's PTY + scrollback survive; `useTerminalPanes` disposes every
// pane only on true app teardown. A PTY dies when the user closes its tab, its
// repo's tabs are dropped (`closeRepoTerminals` + reconcile), or the shell
// exits. The drawer lives in `TerminalBody`, the tab strip in `TerminalTabs`,
// the xterm/PTY lifecycle in `useTerminalPanes`.

import { lazy, Suspense, useEffect, useState } from "react";
import { useUi } from "@/store/ui";
import { useTerminalAgents } from "@/store/terminalAgents";

const LazyTerminalBody = lazy(() => import("./TerminalBody"));

/**
 * The terminal layer. App mounts it for the whole session; it loads the xterm
 * body the first time the terminal is shown and never unmounts it after that.
 */
export function TerminalLayer() {
  const terminalView = useUi((s) => s.terminalView);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const [hasOpened, setHasOpened] = useState(false);
  // Latched during render, never reset: the body must not unmount once mounted.
  if (!hasOpened && terminalView !== "hidden") setHasOpened(true);

  // Agents are shared with Settings, so load them even if the terminal is never opened.
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  if (!hasOpened) return null;
  return (
    <Suspense fallback={null}>
      <LazyTerminalBody />
    </Suspense>
  );
}
