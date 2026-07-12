// Turning an OS file drop into shell input for the integrated terminal.
//
// GNOME Terminal (and macOS Terminal) paste a file's path when you drop it from
// the file manager. GitLane's terminal is xterm.js, so we reproduce that: the
// pane's `drop` handler (see `useTerminalPanes`) reads the drag's `text/uri-list`
// via `pathsFromUriList` (shared, in `lib/paths`) and pastes the shell-quoted
// local paths. This helper is the terminal-specific quoting piece; the DOM
// wiring stays in the view factory.

/** Shell-quote paths and join them with spaces, ready to paste at a prompt.
 * Single-quote wrapping is the safe universal form for POSIX shells; an embedded
 * quote is closed, escaped, and reopened (`'\''`). A trailing space follows so
 * the user can keep typing the command. Returns "" for no paths. */
export function shellQuotePaths(paths: string[]): string {
  if (paths.length === 0) return "";
  const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`);
  return quoted.join(" ") + " ";
}
