import { describe, expect, it } from "vitest";
import type { AcpAgent } from "@/lib/api";
import { persistableAgents } from "./useAiAgentDraft";

const agent = (over: Partial<AcpAgent> = {}): AcpAgent => ({
  id: "a",
  name: "Claude Code",
  command: "npx -y @agentclientprotocol/claude-agent-acp",
  model: "",
  config: {},
  description: "",
  enabled: true,
  available: true,
  ...over,
});

describe("persistableAgents", () => {
  it("omits an unsaved new row until its own Save, and keeps the sibling", () => {
    const saved = [agent()];
    const draft = [agent(), agent({ id: "new", name: "Custom agent", command: "" })];
    expect(persistableAgents(draft, saved, new Set(["new"]))).toEqual(saved);
  });

  it("does not write a half-typed name on another row's persist", () => {
    const saved = [agent(), agent({ id: "b", name: "Cursor", command: "cursor-agent acp" })];
    const draft = [
      agent({ name: "HALF-TYPED" }),
      agent({ id: "b", name: "Cursor", command: "cursor-agent acp", enabled: false }),
    ];
    expect(persistableAgents(draft, saved, new Set(["a"]))).toEqual([
      agent(),
      agent({ id: "b", name: "Cursor", command: "cursor-agent acp", enabled: false }),
    ]);
  });

  it("refuses to write an invalid row that is being saved", () => {
    const saved = [agent()];
    const draft = [agent({ name: "" })];
    expect(persistableAgents(draft, saved, new Set())).toBeNull();
  });
});
