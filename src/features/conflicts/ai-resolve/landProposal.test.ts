import { describe, expect, it, vi } from "vitest";
import { landProposal } from "./landProposal";

const target = () => ({
  setFileResolution: vi.fn(),
  setLineSelection: vi.fn(),
  setCustomResolution: vi.fn(),
  setMode: vi.fn(),
});

const CONFLICTED = ["ctx", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x", "end", ""].join("\n");

describe("landProposal", () => {
  it("lands a side the agent took as line picks, not custom text", () => {
    const t = target();
    landProposal(t, "f.ts", "ctx\na\nend\n", CONFLICTED);

    expect(t.setLineSelection).toHaveBeenCalledWith("f.ts", 1, new Set(["a:0"]));
    expect(t.setCustomResolution).not.toHaveBeenCalled();
    expect(t.setFileResolution).not.toHaveBeenCalled();
  });

  it("lands a rewritten hunk as custom text", () => {
    const t = target();
    landProposal(t, "f.ts", "ctx\nmerged\nend\n", CONFLICTED);

    expect(t.setCustomResolution).toHaveBeenCalledWith("f.ts", 1, ["merged"]);
    expect(t.setLineSelection).not.toHaveBeenCalled();
  });

  it("falls back to a whole-file resolution when the answer can't be aligned", () => {
    const t = target();
    // Reformatted context breaks alignment — attributing lines to the wrong
    // hunk would be worse than showing the rewrite as one file.
    landProposal(t, "f.ts", "different\nentirely\n", CONFLICTED);

    expect(t.setFileResolution).toHaveBeenCalledWith("f.ts", "different\nentirely\n", CONFLICTED);
    expect(t.setLineSelection).not.toHaveBeenCalled();
    expect(t.setCustomResolution).not.toHaveBeenCalled();
  });

  it("switches to the pane that shows the landing", () => {
    const t = target();
    landProposal(t, "f.ts", "ctx\na\nend\n", CONFLICTED);
    expect(t.setMode).toHaveBeenCalledWith("split");
  });
});
