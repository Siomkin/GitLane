import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  ShortcutId,
  ShortcutKind,
  formatBinding,
  keysFor,
  matchesEvent,
  type KeyChord,
  type Shortcut,
} from "./shortcuts";

const chord = (over: Partial<KeyChord>): KeyChord => ({
  code: "KeyA",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const byId = (id: string): Shortcut => {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`no shortcut ${id}`);
  return found;
};

describe("matchesEvent", () => {
  it("resolves mod to Command on macOS and Control elsewhere", () => {
    const settings = byId(ShortcutId.OpenSettings);
    expect(matchesEvent(settings, chord({ code: "Comma", metaKey: true }), true)).toBe(true);
    expect(matchesEvent(settings, chord({ code: "Comma", ctrlKey: true }), false)).toBe(true);
  });

  it("rejects the other primary modifier", () => {
    const settings = byId(ShortcutId.OpenSettings);
    expect(matchesEvent(settings, chord({ code: "Comma", ctrlKey: true }), true)).toBe(false);
    expect(matchesEvent(settings, chord({ code: "Comma", metaKey: true }), false)).toBe(false);
  });

  it("matches any digit in a range binding", () => {
    const tabs = byId(ShortcutId.RepoTabByIndex);
    expect(matchesEvent(tabs, chord({ code: "Digit1", metaKey: true }), true)).toBe(true);
    expect(matchesEvent(tabs, chord({ code: "Digit9", metaKey: true }), true)).toBe(true);
    expect(matchesEvent(tabs, chord({ code: "Digit0", metaKey: true }), true)).toBe(false);
  });

  it("separates a shifted binding from its unshifted neighbour", () => {
    const tabs = byId(ShortcutId.RepoTabByIndex);
    const commits = byId(ShortcutId.ViewCommits);
    const shifted = chord({ code: "Digit1", metaKey: true, shiftKey: true });
    expect(matchesEvent(tabs, shifted, true)).toBe(false);
    expect(matchesEvent(commits, shifted, true)).toBe(true);
    expect(matchesEvent(commits, chord({ code: "Digit1", metaKey: true }), true)).toBe(false);
  });

  it("matches the physical key, so Option's remapped character is irrelevant", () => {
    // ⌘⌥F produces "ƒ" on macOS; matching on code keeps the binding working.
    const nav = byId(ShortcutId.OpenNavigator);
    expect(matchesEvent(nav, chord({ code: "KeyF", metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesEvent(nav, chord({ code: "KeyF", metaKey: true }), true)).toBe(false);
  });

  it("applies the Windows/Linux override instead of the macOS binding", () => {
    const next = byId(ShortcutId.RepoTabNext);
    expect(matchesEvent(next, chord({ code: "BracketRight", metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesEvent(next, chord({ code: "BracketRight", ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesEvent(next, chord({ code: "PageDown", ctrlKey: true }), false)).toBe(true);
  });

  it("treats a null override as unavailable on that platform", () => {
    const macOnly: Shortcut = { ...byId(ShortcutId.OpenSettings), nonMacKeys: null };
    expect(keysFor(macOnly, false)).toBeNull();
    expect(matchesEvent(macOnly, chord({ code: "Comma", ctrlKey: true }), false)).toBe(false);
    expect(formatBinding(macOnly, false)).toBe("");
  });
});

describe("formatBinding", () => {
  it("writes glyphs on macOS and words elsewhere", () => {
    expect(formatBinding(byId(ShortcutId.Push), true)).toBe("⌘⇧P");
    expect(formatBinding(byId(ShortcutId.Push), false)).toBe("Ctrl+Shift+P");
    expect(formatBinding(byId(ShortcutId.OpenNavigator), true)).toBe("⌘⌥F");
    expect(formatBinding(byId(ShortcutId.OpenNavigator), false)).toBe("Ctrl+Alt+F");
  });

  it("labels special keys and ranges readably", () => {
    expect(formatBinding(byId(ShortcutId.RepoTabByIndex), true)).toBe("⌘1…9");
    expect(formatBinding(byId(ShortcutId.OpenSettings), true)).toBe("⌘,");
    expect(formatBinding(byId(ShortcutId.Review), false)).toBe("Ctrl+↵");
    expect(formatBinding(byId(ShortcutId.Dismiss), false)).toBe("Esc");
    expect(formatBinding(byId(ShortcutId.RepoTabNext), false)).toBe("Ctrl+PgDn");
  });
});

describe("registry", () => {
  it("has no duplicate ids", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });

  it("keeps global bindings unambiguous on both platforms", () => {
    for (const isMac of [true, false]) {
      const seen = new Map<string, string>();
      for (const s of SHORTCUTS.filter((s) => s.kind === ShortcutKind.Global)) {
        const keys = keysFor(s, isMac);
        if (!keys) continue;
        for (const code of Array.isArray(keys.code) ? keys.code : [keys.code]) {
          const signature = `${code}|${!!keys.mod}|${!!keys.shift}|${!!keys.alt}`;
          expect(seen.get(signature), `${s.id} collides with ${seen.get(signature)}`).toBeUndefined();
          seen.set(signature, s.id);
        }
      }
    }
  });
});
