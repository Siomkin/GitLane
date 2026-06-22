import { describe, it, expect } from "vitest";
import type { TerminalAgent } from "@/lib/api";
import {
  addAgent,
  agentSignature,
  areAgentsValid,
  bin,
  duplicateAgent,
  isAgentValid,
  isDraftDirty,
  moveAgent,
  previewAvailability,
  removeAgent,
  updateAgent,
} from "./agentDraft";

const agent = (over: Partial<TerminalAgent> & Pick<TerminalAgent, "id">): TerminalAgent => ({
  name: over.id,
  command: over.id,
  description: "",
  enabled: true,
  available: true,
  ...over,
});

const list = (...ids: string[]) => ids.map((id) => agent({ id }));

describe("bin", () => {
  it("returns the executable name, ignoring flags and surrounding space", () => {
    expect(bin("  claude --model opus ")).toBe("claude");
    expect(bin("")).toBe("");
  });
});

describe("isAgentValid / areAgentsValid", () => {
  it("requires a non-blank name and command", () => {
    expect(isAgentValid(agent({ id: "a" }))).toBe(true);
    expect(isAgentValid(agent({ id: "a", name: "  " }))).toBe(false);
    expect(isAgentValid(agent({ id: "a", command: "" }))).toBe(false);
  });
  it("areAgentsValid is true only when every agent is valid", () => {
    expect(areAgentsValid(list("a", "b"))).toBe(true);
    expect(areAgentsValid([agent({ id: "a" }), agent({ id: "b", command: "" })])).toBe(false);
    expect(areAgentsValid([])).toBe(true);
  });
});

describe("agentSignature / isDraftDirty", () => {
  it("ignores the availability flag when comparing", () => {
    const a = [agent({ id: "x", available: true })];
    const b = [agent({ id: "x", available: false })];
    expect(agentSignature(a)).toBe(agentSignature(b));
    expect(isDraftDirty(a, b)).toBe(false);
  });
  it("reports a dirty draft when an editable field changes", () => {
    const saved = list("x");
    expect(isDraftDirty(updateAgent(saved, "x", { name: "New" }), saved)).toBe(true);
    expect(isDraftDirty(saved, saved)).toBe(false);
  });
});

describe("addAgent", () => {
  it("appends a fresh, enabled, blank agent with a unique id", () => {
    const before = list("a");
    const after = addAgent(before);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ name: "", command: "", enabled: true, available: false });
    expect(after[1].id).not.toBe("a");
    expect(before).toHaveLength(1); // input untouched
  });
});

describe("updateAgent", () => {
  it("patches only the matching agent", () => {
    const after = updateAgent(list("a", "b"), "b", { name: "Renamed", enabled: false });
    expect(after[0]).toMatchObject({ id: "a", name: "a" });
    expect(after[1]).toMatchObject({ id: "b", name: "Renamed", enabled: false });
  });
  it("is a no-op for an unknown id", () => {
    const before = list("a");
    expect(updateAgent(before, "missing", { name: "X" })).toEqual(before);
  });
});

describe("duplicateAgent", () => {
  it("inserts a copy with a new id right after the source", () => {
    const after = duplicateAgent(list("a", "b"), "a");
    expect(after).toHaveLength(3);
    expect(after[0].id).toBe("a"); // source stays put
    expect(after[1].id).not.toBe("a");
    expect(after[1].name).toBe("a copy");
    expect(after[1].command).toBe("a");
    expect(after[1].available).toBe(false);
    expect(after[2].id).toBe("b");
  });
  it("keeps a blank name blank rather than appending ' copy'", () => {
    const after = duplicateAgent([agent({ id: "a", name: "" })], "a");
    expect(after[1].name).toBe("");
  });
  it("is a no-op for an unknown id", () => {
    const before = list("a");
    expect(duplicateAgent(before, "missing")).toEqual(before);
  });
});

describe("removeAgent", () => {
  it("drops the matching agent", () => {
    expect(removeAgent(list("a", "b"), "a").map((x) => x.id)).toEqual(["b"]);
  });
});

describe("moveAgent", () => {
  it("reorders within range", () => {
    expect(moveAgent(list("a", "b", "c"), 0, 2).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(moveAgent(list("a", "b", "c"), 2, 0).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
  it("is a no-op for same/out-of-range indices", () => {
    const before = list("a", "b");
    expect(moveAgent(before, 1, 1)).toBe(before);
    expect(moveAgent(before, 0, 5)).toBe(before);
    expect(moveAgent(before, -1, 0)).toBe(before);
  });
});

describe("previewAvailability", () => {
  it("does not reuse availability after a command edit", () => {
    const saved = agent({ id: "x", command: "claude" });
    const edited = agent({ id: "x", command: "claude --model opus" });
    expect(previewAvailability(edited, saved, undefined)).toBe("unchecked");
    expect(previewAvailability(edited, saved, { command: edited.command, status: "missing" })).toBe(
      "missing",
    );
  });
  it("reuses the saved probe when the command is unchanged", () => {
    const saved = agent({ id: "x", command: "claude", available: true });
    expect(previewAvailability(saved, saved, undefined)).toBe("available");
    expect(previewAvailability(agent({ id: "x", command: "claude", available: false }), { ...saved, available: false }, undefined)).toBe("missing");
  });
});
