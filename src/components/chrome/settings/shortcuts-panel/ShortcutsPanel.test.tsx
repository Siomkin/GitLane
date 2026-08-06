import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isMac } from "@/lib/platform";
import { SHORTCUTS, ShortcutId, formatBinding, keysFor } from "@/lib/shortcuts";
import { ShortcutsPanel } from "./ShortcutsPanel";

describe("ShortcutsPanel", () => {
  it("lists every shortcut available on this platform", () => {
    render(<ShortcutsPanel />);

    for (const shortcut of SHORTCUTS) {
      if (!keysFor(shortcut, isMac)) continue;
      expect(screen.getByText(shortcut.description)).toBeInTheDocument();
    }
  });

  it("writes the keys the way this platform writes them", () => {
    render(<ShortcutsPanel />);

    const navigator = SHORTCUTS.find((s) => s.id === ShortcutId.OpenNavigator)!;
    expect(formatBinding(navigator, isMac)).toBe(isMac ? "⌘⌥F" : "Ctrl+Alt+F");
    expect(screen.getByText(formatBinding(navigator, isMac))).toBeInTheDocument();
  });

  it("groups shortcuts under their scope", () => {
    render(<ShortcutsPanel />);

    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.getByText("DIALOGS")).toBeInTheDocument();
  });
});
