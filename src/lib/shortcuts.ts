// The keyboard-shortcut registry (GL-346): every shortcut the app supports,
// declared once as data. The dispatcher (`useShortcuts`) matches events against
// it and the Settings → Shortcuts panel renders it, so the listing can never
// drift from the behaviour.
//
// Bindings use an abstract `mod` modifier that resolves to ⌘ on macOS and Ctrl
// elsewhere, and match on `KeyboardEvent.code` (the physical key) so layouts
// and dead keys — Option+F yields "ƒ" on macOS — can't break them.

export const ShortcutScope = {
  Global: "Global",
  History: "History",
  Changes: "Changes",
  Editor: "Editor",
  Dialogs: "Dialogs",
} as const;
export type ShortcutScope = (typeof ShortcutScope)[keyof typeof ShortcutScope];

/** Global shortcuts run through the dispatcher; contextual ones stay owned by
 *  the focused component (dialogs, forms, the editor) and are declared here
 *  only so the Settings panel can list them. */
export const ShortcutKind = {
  Global: "global",
  Contextual: "contextual",
} as const;
export type ShortcutKind = (typeof ShortcutKind)[keyof typeof ShortcutKind];

export const ShortcutId = {
  OpenNavigator: "openNavigator",
  RepoTabByIndex: "repoTabByIndex",
  RepoTabPrev: "repoTabPrev",
  RepoTabNext: "repoTabNext",
  ViewCommits: "viewCommits",
  ViewPulls: "viewPulls",
  OpenSettings: "openSettings",
  ToggleTerminal: "toggleTerminal",
  HistorySearch: "historySearch",
  Review: "review",
  Push: "push",
  Pull: "pull",
  NewBranch: "newBranch",
  Stash: "stash",
  BackToGraph: "backToGraph",
  GraphNav: "graphNav",
  FileListNav: "fileListNav",
  EditorSave: "editorSave",
  SubmitForm: "submitForm",
  Dismiss: "dismiss",
} as const;
export type ShortcutId = (typeof ShortcutId)[keyof typeof ShortcutId];

export interface ShortcutKeys {
  /** The primary modifier: ⌘ on macOS, Ctrl on Windows/Linux. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** One `KeyboardEvent.code`, or several when one row covers a range (⌘1…⌘9). */
  code: string | string[];
  /** Key label for the Settings panel when `code` alone doesn't read well. */
  label?: string;
}

export interface Shortcut {
  id: ShortcutId;
  keys: ShortcutKeys;
  /** Windows/Linux binding when the macOS one collides there; `null` means the
   *  shortcut is not offered off macOS. */
  nonMacKeys?: ShortcutKeys | null;
  scope: ShortcutScope;
  kind: ShortcutKind;
  description: string;
}

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];

export const SHORTCUTS: Shortcut[] = [
  {
    id: ShortcutId.RepoTabByIndex,
    keys: { mod: true, code: DIGIT_CODES, label: "1…9" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Switch to repository tab 1–8 (9 selects the last tab)",
  },
  {
    id: ShortcutId.RepoTabPrev,
    keys: { mod: true, shift: true, code: "BracketLeft" },
    // Ctrl+Shift+[ is unreliable across Windows/Linux layouts; the browser-tab
    // idiom there is Ctrl+PgUp/PgDn.
    nonMacKeys: { mod: true, code: "PageUp" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Previous repository tab",
  },
  {
    id: ShortcutId.RepoTabNext,
    keys: { mod: true, shift: true, code: "BracketRight" },
    nonMacKeys: { mod: true, code: "PageDown" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Next repository tab",
  },
  {
    id: ShortcutId.ViewCommits,
    keys: { mod: true, shift: true, code: "Digit1" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Show the Commits view",
  },
  {
    id: ShortcutId.ViewPulls,
    keys: { mod: true, shift: true, code: "Digit2" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Show the Pull Requests view",
  },
  {
    id: ShortcutId.OpenNavigator,
    keys: { mod: true, alt: true, code: "KeyF" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Open the branch navigator and focus its filter",
  },
  {
    id: ShortcutId.OpenSettings,
    keys: { mod: true, code: "Comma" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Open Settings",
  },
  {
    id: ShortcutId.ToggleTerminal,
    keys: { mod: true, code: "KeyT" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Show or hide the terminal",
  },
  {
    id: ShortcutId.HistorySearch,
    keys: { mod: true, code: "KeyF" },
    scope: ShortcutScope.History,
    kind: ShortcutKind.Contextual,
    description: "Search the commit history",
  },
  {
    id: ShortcutId.Review,
    keys: { mod: true, code: "Enter" },
    scope: ShortcutScope.Changes,
    kind: ShortcutKind.Global,
    description: "Review all files in the selected commit, or the working changes",
  },
  {
    id: ShortcutId.Push,
    keys: { mod: true, shift: true, code: "KeyP" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Push the current branch",
  },
  {
    id: ShortcutId.Pull,
    keys: { mod: true, shift: true, code: "KeyL" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Pull the current branch",
  },
  {
    id: ShortcutId.NewBranch,
    keys: { mod: true, code: "KeyB" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "New branch from HEAD",
  },
  {
    id: ShortcutId.Stash,
    keys: { mod: true, shift: true, code: "KeyS" },
    scope: ShortcutScope.Changes,
    kind: ShortcutKind.Global,
    description: "Stash working changes",
  },
  {
    id: ShortcutId.BackToGraph,
    keys: { code: "Home" },
    scope: ShortcutScope.Global,
    kind: ShortcutKind.Global,
    description: "Back to the commit graph",
  },
  {
    id: ShortcutId.GraphNav,
    keys: { code: ["ArrowUp", "ArrowDown"], label: "↑ ↓" },
    scope: ShortcutScope.History,
    kind: ShortcutKind.Contextual,
    description: "Move the commit selection (Shift extends the range)",
  },
  {
    id: ShortcutId.FileListNav,
    keys: { code: ["ArrowUp", "ArrowDown"], label: "↑ ↓" },
    scope: ShortcutScope.Changes,
    kind: ShortcutKind.Contextual,
    description: "Move through the changed-file list",
  },
  {
    id: ShortcutId.EditorSave,
    keys: { mod: true, code: "KeyS" },
    scope: ShortcutScope.Editor,
    kind: ShortcutKind.Contextual,
    description: "Save the open file",
  },
  {
    id: ShortcutId.SubmitForm,
    keys: { mod: true, code: "Enter" },
    scope: ShortcutScope.Dialogs,
    kind: ShortcutKind.Contextual,
    description: "Submit the focused form — commit message, comment, or prompt",
  },
  {
    id: ShortcutId.Dismiss,
    keys: { code: "Escape" },
    scope: ShortcutScope.Dialogs,
    kind: ShortcutKind.Contextual,
    description: "Close the open dialog, menu, or popover",
  },
];

/** The binding in force on this platform, or `null` when the shortcut is not
 *  offered there. */
export function keysFor(shortcut: Shortcut, isMac: boolean): ShortcutKeys | null {
  if (isMac) return shortcut.keys;
  return shortcut.nonMacKeys === undefined ? shortcut.keys : shortcut.nonMacKeys;
}

/** The parts of a `KeyboardEvent` matching needs — so the matcher stays pure
 *  and testable without a DOM. */
export interface KeyChord {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchesEvent(shortcut: Shortcut, event: KeyChord, isMac: boolean): boolean {
  const keys = keysFor(shortcut, isMac);
  if (!keys) return false;
  const codes = Array.isArray(keys.code) ? keys.code : [keys.code];
  if (!codes.includes(event.code)) return false;
  // Exact modifier discipline: the *other* primary modifier disqualifies, so
  // Ctrl+1 on macOS never triggers a ⌘1 binding (and vice versa).
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const otherMod = isMac ? event.ctrlKey : event.metaKey;
  return (
    mod === !!keys.mod &&
    !otherMod &&
    event.shiftKey === !!keys.shift &&
    event.altKey === !!keys.alt
  );
}

const KEY_LABELS: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

function keyLabel(keys: ShortcutKeys): string {
  if (keys.label) return keys.label;
  const code = Array.isArray(keys.code) ? keys.code[0] : keys.code;
  return KEY_LABELS[code] ?? code.replace(/^(Key|Digit)/, "");
}

/** The shortcut written the way its platform writes it: `⌘⇧P` on macOS,
 *  `Ctrl+Shift+P` on Windows/Linux. Empty when unavailable on the platform. */
export function formatBinding(shortcut: Shortcut, isMac: boolean): string {
  const keys = keysFor(shortcut, isMac);
  if (!keys) return "";
  const key = keyLabel(keys);
  if (isMac) {
    return `${keys.mod ? "⌘" : ""}${keys.shift ? "⇧" : ""}${keys.alt ? "⌥" : ""}${key}`;
  }
  const parts = [keys.mod && "Ctrl", keys.shift && "Shift", keys.alt && "Alt", key];
  return parts.filter(Boolean).join("+");
}
