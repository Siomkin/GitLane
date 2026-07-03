import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { IpcValidationError, parse } from "./validate";
import { api } from "./index";

beforeEach(() => invokeMock.mockReset());

describe("parse / IpcValidationError", () => {
  const schema = z.object({ a: z.number(), nested: z.object({ b: z.string() }) });

  it("returns the typed value when the payload matches", () => {
    expect(parse(schema, { a: 1, nested: { b: "ok" } }, "cmd")).toEqual({
      a: 1,
      nested: { b: "ok" },
    });
  });

  it("throws IpcValidationError naming the command and the offending field path", () => {
    try {
      parse(schema, { a: "nope", nested: {} }, "commit_graph");
      throw new Error("expected parse to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IpcValidationError);
      const err = e as IpcValidationError;
      expect(err.command).toBe("commit_graph");
      expect(err.message).toContain('Malformed response from "commit_graph"');
      // Field paths from the schema appear in the summary.
      expect(err.message).toContain("a:");
      expect(err.message).toContain("nested.b:");
    }
  });
});

// End-to-end proof that the validation is actually wired into the lib/api seam:
// a deliberate field mismatch from `invoke` surfaces here as a clear, named
// error instead of an undefined-access crash deep in a component (GL-57).
describe("lib/api seam validation", () => {
  it("commit_graph: rejects a payload missing a required field, accepts a valid one", async () => {
    invokeMock.mockResolvedValueOnce({ commits: [], edges: [], laneCount: 1, head: null }); // no `truncated`
    await expect(api.commitGraph("/r")).rejects.toThrow(/commit_graph[\s\S]*truncated/);

    const valid = { commits: [], edges: [], laneCount: 1, head: null, truncated: false };
    invokeMock.mockResolvedValueOnce(valid);
    await expect(api.commitGraph("/r")).resolves.toEqual(valid);
  });

  it("working_changes: defaults a missing `conflicted` to [], rejects a wrong-typed field", async () => {
    invokeMock.mockResolvedValueOnce({ staged: [], unstaged: [] });
    await expect(api.workingChanges("/r")).resolves.toEqual({
      staged: [],
      unstaged: [],
      conflicted: [],
    });

    invokeMock.mockResolvedValueOnce({ staged: "not-an-array", unstaged: [] });
    await expect(api.workingChanges("/r")).rejects.toThrow(IpcValidationError);
  });

  it("file_diff: rejects a payload missing the line stats", async () => {
    invokeMock.mockResolvedValueOnce({ path: "a.ts", status: "M", binary: false, hunks: [] });
    await expect(api.fileDiff("/r", "a.ts", false)).rejects.toThrow(/file_diff/);

    const valid = {
      path: "a.ts",
      status: "M",
      add: 1,
      del: 0,
      binary: false,
      hunks: [],
      truncated: false,
    };
    invokeMock.mockResolvedValueOnce(valid);
    await expect(api.fileDiff("/r", "a.ts", false)).resolves.toEqual(valid);
  });

  it("pull_request_detail: rejects an invalid enum value", async () => {
    const valid = {
      number: 1,
      title: "t",
      state: "OPEN",
      headRef: "h",
      baseRef: "b",
      author: { login: "x", name: "X" },
      createdAt: "2026-01-01",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      isDraft: false,
      url: "https://example/pr/1",
      mergeable: "UNKNOWN",
      body: "",
      comments: 0,
      files: [],
      commentList: [],
      reviewers: [],
      reviews: [],
      assignees: [],
      labels: [],
      milestone: null,
      commits: [],
    };
    invokeMock.mockResolvedValueOnce(valid);
    await expect(api.pullRequestDetail("/r", 1)).resolves.toMatchObject({ number: 1 });

    invokeMock.mockResolvedValueOnce({ ...valid, state: "NOT_A_STATE" });
    await expect(api.pullRequestDetail("/r", 1)).rejects.toThrow(/pull_request_detail/);
  });

  // Review `state` is a raw, non-exhaustive gh value on the Rust side (GL-112):
  // a state this build doesn't know must degrade to COMMENTED, not throw and
  // take the whole PR detail pane down with it.
  it("pull_request_detail: tolerates an unknown review state", async () => {
    const detail = {
      number: 1,
      title: "t",
      state: "OPEN",
      headRef: "h",
      baseRef: "b",
      author: { login: "x", name: "X" },
      createdAt: "2026-01-01",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      isDraft: false,
      url: "https://example/pr/1",
      mergeable: "UNKNOWN",
      body: "",
      comments: 0,
      files: [],
      commentList: [],
      reviewers: [],
      reviews: [
        { author: { login: "a", name: "A" }, state: "APPROVED" },
        { author: { login: "b", name: "B" }, state: "SOME_FUTURE_STATE" },
      ],
      assignees: [],
      labels: [],
      milestone: null,
      commits: [],
    };
    invokeMock.mockResolvedValueOnce(detail);
    await expect(api.pullRequestDetail("/r", 1)).resolves.toMatchObject({
      reviews: [
        { author: { login: "a", name: "A" }, state: "APPROVED" },
        { author: { login: "b", name: "B" }, state: "COMMENTED" },
      ],
    });
  });
});
