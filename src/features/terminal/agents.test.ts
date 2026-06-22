import { describe, it, expect } from "vitest";
import type { TerminalAgent } from "@/lib/api";
import { selectEnabledAgents } from "./agents";

const a = (over: Partial<TerminalAgent> & Pick<TerminalAgent, "id">): TerminalAgent => ({
  name: over.id,
  command: over.id,
  description: "",
  enabled: true,
  available: true,
  ...over,
});

describe("selectEnabledAgents", () => {
  it("keeps enabled agents and drops disabled ones", () => {
    const all = [a({ id: "opencode" }), a({ id: "kimi", enabled: false }), a({ id: "claude" })];
    expect(selectEnabledAgents(all).map((x) => x.id)).toEqual(["opencode", "claude"]);
  });

  it("preserves input order and passes availability through", () => {
    const sel = selectEnabledAgents([
      a({ id: "codex", available: false }),
      a({ id: "claude", available: true }),
      a({ id: "kimi", enabled: false }),
    ]);
    expect(sel.map((x) => [x.id, x.available])).toEqual([
      ["codex", false],
      ["claude", true],
    ]);
  });

  it("returns nothing for an empty or all-disabled list", () => {
    expect(selectEnabledAgents([])).toEqual([]);
    expect(selectEnabledAgents([a({ id: "x", enabled: false })])).toEqual([]);
  });
});
