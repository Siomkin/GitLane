// The Rust config is the source of truth for the agent instructions; the TS
// defaults only cover the paint before the first backend load and the per-field
// "Reset" in Settings. Drift between them is invisible until a user hits one of
// those paths and gets a different prompt than the one that persists, so pin the
// two copies together here.

import { describe, expect, it } from "vitest";
import { DEFAULT_COMMIT_AGENT_MESSAGES } from "./commitAgentMessages";

// Read through `import.meta.glob` rather than `node:fs`, like the raw-select
// guard does, so the check needs no `@types/node`.
const RUST_SOURCES = import.meta.glob<string>(
  "../../src-tauri/src/terminal_agents/defaults.rs",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

function rustConst(name: string): string {
  const source = Object.values(RUST_SOURCES)[0];
  if (!source) throw new Error("terminal_agents/defaults.rs not found");
  const match = source.match(new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) throw new Error(`${name} not found in terminal_agents/defaults.rs`);
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

describe("commit agent message defaults", () => {
  it("match the Rust defaults they stand in for", () => {
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction).toBe(
      rustConst("DEFAULT_DRAFT_INSTRUCTION"),
    );
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.commitInstruction).toBe(
      DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction,
    );
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.descriptionInstruction).toBe(
      rustConst("DEFAULT_DESCRIPTION_INSTRUCTION"),
    );
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.map((row) => row.id)).toEqual([
      "short",
      "full",
      "impl",
      "release",
      "review",
      "test",
    ]);
    const byId = Object.fromEntries(
      DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.map((row) => [row.id, row]),
    );
    expect(byId.short.instruction).toBe(rustConst("DEFAULT_AI_ACTION_SHORT"));
    expect(byId.short.title).toBe("Short description");
    expect(byId.full.instruction).toBe(rustConst("DEFAULT_AI_ACTION_FULL"));
    expect(byId.impl.instruction).toBe(rustConst("DEFAULT_AI_ACTION_IMPL"));
    expect(byId.impl.title).toBe("Implementation comment");
    expect(byId.release.instruction).toBe(rustConst("DEFAULT_AI_ACTION_RELEASE"));
    expect(byId.review.instruction).toBe(rustConst("DEFAULT_AI_ACTION_REVIEW"));
    expect(byId.test.instruction).toBe(rustConst("DEFAULT_AI_ACTION_TEST"));
    expect(DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.every((row) => row.enabled)).toBe(true);
  });
});
