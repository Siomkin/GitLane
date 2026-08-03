// The Rust config is the source of truth for the agent instructions; the TS
// defaults only cover the paint before the first backend load and the per-field
// "Reset" in Settings. Drift between them is invisible until a user hits one of
// those paths and gets a different prompt than the one that persists, so pin the
// two copies together here.

import { describe, expect, it } from "vitest";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "./commitAgentMessages";

// Read through `import.meta.glob` rather than `node:fs`, like the raw-select
// guard does, so the check needs no `@types/node`.
const RUST_SOURCES = import.meta.glob<string>("../../src-tauri/src/terminal_agents.rs", {
  query: "?raw",
  import: "default",
  eager: true,
});

function rustConst(name: string): string {
  const source = Object.values(RUST_SOURCES)[0];
  if (!source) throw new Error("terminal_agents.rs not found");
  const match = source.match(new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) throw new Error(`${name} not found in terminal_agents.rs`);
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

describe("commit agent message defaults", () => {
  it("match the Rust defaults they stand in for", () => {
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction).toBe(
      rustConst("DEFAULT_DRAFT_INSTRUCTION"),
    );
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.commitInstruction).toBe(
      rustConst("DEFAULT_COMMIT_INSTRUCTION"),
    );
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.descriptionInstruction).toBe(
      rustConst("DEFAULT_DESCRIPTION_INSTRUCTION"),
    );
  });
});
