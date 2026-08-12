import { describe, expect, it } from "vitest";
import { formatElapsed, waitingFallback, waitingStatus } from "./agentRun";

describe("formatElapsed", () => {
  it("reads as seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("zero-pads seconds past a minute so the width stays stable while ticking", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(64_000)).toBe("1m 04s");
    expect(formatElapsed(750_000)).toBe("12m 30s");
  });

  it("never renders a negative clock when the clock jumps backwards", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("waitingStatus", () => {
  it("surfaces agent stderr errors instead of the timed fallback", () => {
    expect(
      waitingStatus({
        agentName: "OpenCode",
        progress: "Error · stream error (opencode/big-pickle)",
        elapsedMs: 57_000,
        verb: "describing",
      }),
    ).toBe("Error · stream error (opencode/big-pickle)");
  });

  it("shows titled progress instead of the timed fallback", () => {
    expect(
      waitingStatus({
        agentName: "Codex",
        progress: "Running · git show ca9a464…",
        elapsedMs: 70_000,
        verb: "describing",
      }),
    ).toBe("Running · git show ca9a464…");
  });

  it("keeps the agent name on early fallbacks so a quiet start is still labelled", () => {
    expect(
      waitingStatus({
        agentName: "OpenCode",
        progress: null,
        elapsedMs: 2_000,
        verb: "drafting",
      }),
    ).toBe("OpenCode · Starting the agent…");
    expect(waitingFallback(30_000, "describing")).toBe(
      "Still working — this can take a minute…",
    );
  });

  it("escalates past a stale Sending the prompt… so quiet agents like OpenCode stay honest", () => {
    expect(
      waitingStatus({
        agentName: "OpenCode",
        progress: "Sending the prompt…",
        elapsedMs: 29_000,
        verb: "drafting",
      }),
    ).toBe("Still working — this can take a minute…");
  });

  it("escalates past a stalled Using {model}… handshake pin", () => {
    expect(
      waitingStatus({
        agentName: "OpenCode",
        progress: "Using opencode/big-pickle…",
        elapsedMs: 29_000,
        verb: "describing",
      }),
    ).toBe("Still working — this can take a minute…");
  });
});
