import { describe, expect, it } from "vitest";
import type { AcpAdapter } from "@/lib/api";
import {
  CUSTOM_ADAPTER,
  NO_ADAPTER,
  adapterChoiceOf,
  bakedModelParamChips,
  commandForChoice,
  coveredBakedParamKeys,
  effortPinOf,
  formatModelParams,
  modelLabel,
  parseModelParams,
  uniqueAgentName,
} from "./acpFields";

const adapters: AcpAdapter[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "npx -y @agentclientprotocol/claude-agent-acp",
    install: "npm i -g @agentclientprotocol/claude-agent-acp",
    docs: "https://docs.claude.com/en/docs/claude-code/overview",
    requires: "The `claude` CLI, signed in.",
    available: true,
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx -y @agentclientprotocol/codex-acp",
    install: "npm i -g @agentclientprotocol/codex-acp",
    docs: "https://developers.openai.com/codex/cli",
    requires: "The `codex` CLI, signed in.",
    available: true,
  },
];

describe("adapterChoiceOf", () => {
  it("recognises a catalogue adapter, and treats anything else as custom", () => {
    expect(adapterChoiceOf("npx -y @agentclientprotocol/codex-acp", adapters)).toBe("codex");
    expect(adapterChoiceOf("  ", adapters)).toBe(NO_ADAPTER);
    // A user-tweaked command must not be re-labelled as the stock adapter —
    // that would hide their edit behind a familiar name.
    expect(adapterChoiceOf("npx -y @agentclientprotocol/codex-acp --verbose", adapters)).toBe(
      CUSTOM_ADAPTER,
    );
  });
});

describe("commandForChoice", () => {
  it("fills in the catalogue command, clears for none, and preserves a custom edit", () => {
    expect(commandForChoice("claude", adapters, "old")).toBe(
      "npx -y @agentclientprotocol/claude-agent-acp",
    );
    expect(commandForChoice(NO_ADAPTER, adapters, "old")).toBe("");
    // Switching to Custom must not wipe the field the user is about to edit.
    expect(commandForChoice(CUSTOM_ADAPTER, adapters, "my-adapter --flag")).toBe(
      "my-adapter --flag",
    );
    expect(commandForChoice("unknown-id", adapters, "keep me")).toBe("keep me");
  });
});

describe("modelLabel", () => {
  it("falls back to the id when the adapter gives no display name", () => {
    expect(modelLabel({ id: "gpt-5.6-sol[low]", name: "", description: "" })).toBe(
      "gpt-5.6-sol[low]",
    );
    expect(modelLabel({ id: "x", name: "GPT-5.6-Sol (low)", description: "" })).toBe(
      "GPT-5.6-Sol (low)",
    );
  });
});

describe("parseModelParams / bakedModelParamChips", () => {
  it("reads Cursor-style key=value params and Codex bare effort suffixes", () => {
    expect(parseModelParams("grok-4.5[effort=high,fast=true]")).toEqual({
      effort: "high",
      fast: "true",
    });
    expect(parseModelParams("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]")).toEqual({
      context: "272k",
      reasoning: "medium",
      fast: "false",
    });
    expect(parseModelParams("gpt-5.6-sol[low]")).toEqual({ effort: "low" });
    expect(parseModelParams("default[]")).toEqual({});
    expect(parseModelParams("plain")).toEqual({});
  });

  it("surfaces effort/fast chips and skips keys covered by editable config options", () => {
    expect(bakedModelParamChips("grok-4.5[effort=high,fast=true]")).toEqual([
      { key: "effort", label: "Effort", value: "high" },
      { key: "fast", label: "Fast", value: "true" },
    ]);
    expect(formatModelParams("grok-4.5[effort=high,fast=true]")).toBe("effort=high · fast=true");
    // Codex already has Effort / Fast selectors — don't duplicate them as chips.
    const covered = coveredBakedParamKeys([
      { id: "reasoning_effort", category: "thought_level" },
      { id: "fast-mode", category: "model_config" },
    ]);
    expect(bakedModelParamChips("gpt-5.6-sol[low]", covered)).toEqual([]);
  });
});

describe("effortPinOf", () => {
  it("finds the pin whatever the adapter calls the option", () => {
    // claude-agent-acp says `effort`, Codex says `reasoning_effort` — reading
    // only the first left Codex's pin invisible on the collapsed row.
    expect(effortPinOf({ effort: "high" })).toBe("high");
    expect(effortPinOf({ reasoning_effort: "low" })).toBe("low");
    expect(effortPinOf({ fast: "on" })).toBe("");
    expect(effortPinOf({})).toBe("");
  });
});

describe("uniqueAgentName", () => {
  it("numbers repeats so two agents on one adapter stay tellable apart", () => {
    // The menu lists agents by name, so a second "Cursor" would be
    // indistinguishable exactly where the choice is made.
    expect(uniqueAgentName("Cursor", [])).toBe("Cursor");
    expect(uniqueAgentName("Cursor", ["Cursor"])).toBe("Cursor 2");
    expect(uniqueAgentName("Cursor", ["Cursor", "Cursor 2"])).toBe("Cursor 3");
    // Clashes are matched case- and whitespace-insensitively, since that is how
    // they read to a human scanning the menu.
    expect(uniqueAgentName("Cursor", ["  cursor "])).toBe("Cursor 2");
    // A gap is reused rather than skipped past.
    expect(uniqueAgentName("Cursor", ["Cursor", "Cursor 3"])).toBe("Cursor 2");
  });
});
