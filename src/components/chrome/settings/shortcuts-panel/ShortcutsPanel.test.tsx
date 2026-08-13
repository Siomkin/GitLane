import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isMac } from "@/lib/platform";
import { SHORTCUTS, ShortcutId, bindingParts, keysFor } from "@/lib/shortcuts";
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
    const row = screen.getByText(navigator.description).closest("div")!;
    for (const part of bindingParts(navigator, isMac)) {
      expect(within(row).getByText(part)).toBeInTheDocument();
    }
  });

  it("groups shortcuts under their scope", () => {
    render(<ShortcutsPanel />);

    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.getByText("DIALOGS")).toBeInTheDocument();
  });
});
