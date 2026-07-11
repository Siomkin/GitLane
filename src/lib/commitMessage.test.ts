import { describe, expect, it } from "vitest";
import { fullCommitMessage, splitCommitMessage } from "./commitMessage";

describe("splitCommitMessage", () => {
  it("splits summary from body and normalizes CRLF (Windows-originated messages)", () => {
    expect(splitCommitMessage("feat: thing\r\n\r\nbody line 1\r\nbody line 2")).toEqual({
      summary: "feat: thing",
      description: "body line 1\nbody line 2",
    });
  });

  it("returns an empty description for a summary-only message", () => {
    expect(splitCommitMessage("feat: thing")).toEqual({ summary: "feat: thing", description: "" });
    expect(splitCommitMessage("feat: thing\n\n")).toEqual({ summary: "feat: thing", description: "" });
  });

  it("trims extra blank lines around the body but keeps internal ones", () => {
    expect(splitCommitMessage("subject\n\n\n\nfirst\n\nsecond\n\n")).toEqual({
      summary: "subject",
      description: "first\n\nsecond",
    });
  });

  it("handles whitespace-only and empty messages", () => {
    expect(splitCommitMessage("")).toEqual({ summary: "", description: "" });
    expect(splitCommitMessage("   \r\n  \n ")).toEqual({ summary: "", description: "" });
  });

  it("trims the summary line itself", () => {
    expect(splitCommitMessage("  padded subject  \n\nbody")).toEqual({
      summary: "padded subject",
      description: "body",
    });
  });
});

describe("fullCommitMessage", () => {
  it("joins summary and trimmed body with a blank line", () => {
    expect(fullCommitMessage("subject", "  body  ")).toBe("subject\n\nbody");
  });

  it("returns the bare summary when the body is blank", () => {
    expect(fullCommitMessage("subject", "")).toBe("subject");
    expect(fullCommitMessage("subject", "   \n ")).toBe("subject");
  });

  it("round-trips through splitCommitMessage", () => {
    const { summary, description } = splitCommitMessage(fullCommitMessage("s", "d1\n\nd2"));
    expect(summary).toBe("s");
    expect(description).toBe("d1\n\nd2");
  });
});
