// Pure tests for the prompt builders: each takes the requestPrompt/run
// callbacks as parameters, so the prompt payloads (titles, defaults, options
// ordering, submit wiring) are assertable without mounting a menu.
import { describe, expect, it, vi } from "vitest";

import type { BranchInfo } from "@/lib/api";
import type { PromptRequest } from "@/store/ui";
import {
  promptAnnotatedTag,
  promptCompareBranch,
  promptCreateWorktree,
  promptNewBranchWorktree,
} from "./prompts";

const capturePrompt = () => {
  const requests: PromptRequest[] = [];
  const requestPrompt = (req: PromptRequest) => {
    requests.push(req);
  };
  return { requests, requestPrompt };
};

const branch = (name: string, kind: BranchInfo["kind"] = "local"): BranchInfo =>
  ({ name, kind } as BranchInfo);

describe("promptCreateWorktree", () => {
  it("pre-fills a sanitized sibling path and creates at the submitted path", () => {
    const { requests, requestPrompt } = capturePrompt();
    const run = vi.fn((op: () => Promise<string>) => void op());
    const createWorktreeAt = vi.fn(async () => "ok");
    promptCreateWorktree(requestPrompt, run, createWorktreeAt, "abc123", "/work/repo/", "feat/x y");

    expect(requests).toHaveLength(1);
    // Trailing slash trimmed, ref sanitized to word chars/dots/dashes.
    expect(requests[0].defaultValue).toBe("/work/repo-wt-feat-x-y");
    requests[0].onSubmit("/elsewhere/wt");
    expect(createWorktreeAt).toHaveBeenCalledWith("/elsewhere/wt", "abc123");
  });
});

describe("promptNewBranchWorktree", () => {
  it("derives the worktree path from the submitted branch name and validates it", () => {
    const { requests, requestPrompt } = capturePrompt();
    const run = vi.fn((op: () => Promise<string>) => void op());
    const createWorktreeAt = vi.fn(async () => "ok");
    promptNewBranchWorktree(requestPrompt, run, createWorktreeAt, "abc123", "/work/repo", "abc1234");

    expect(requests).toHaveLength(1);
    // Branch-name validation is wired (same rules as Create/Rename branch).
    expect(requests[0].validate?.("feature/ok")).toBeNull();
    expect(requests[0].validate?.("bad..name")).toBeTruthy();
    requests[0].onSubmit("feature/mine");
    expect(createWorktreeAt).toHaveBeenCalledWith("/work/repo-wt-feature-mine", "abc123", "feature/mine");
  });
});

describe("promptCompareBranch", () => {
  const branches = [
    branch("main"),
    branch("zeta"),
    branch("alpha"),
    branch("origin/main", "remote"),
    branch("origin/alpha", "remote"),
    branch("head-branch"),
  ];

  it("excludes the head, sorts current-first then locals alphabetically, remotes last with hints", () => {
    const { requests, requestPrompt } = capturePrompt();
    const openCompare = vi.fn();
    promptCompareBranch(requestPrompt, openCompare, branches, "head-branch", "zeta");

    expect(requests).toHaveLength(1);
    expect(requests[0].options?.map((o) => o.value)).toEqual([
      "zeta", // current first
      "alpha",
      "main",
      "origin/alpha",
      "origin/main",
    ]);
    expect(requests[0].options?.[0].hint).toBe("current");
    const options = requests[0].options ?? [];
    expect(options[options.length - 1]?.hint).toBe("remote");
    // The current branch pre-fills the picker (it's the most likely base).
    expect(requests[0].defaultValue).toBe("zeta");
  });

  it("submits the trimmed pick as the compare base and ignores an empty pick", () => {
    const { requests, requestPrompt } = capturePrompt();
    const openCompare = vi.fn(async () => {});
    promptCompareBranch(requestPrompt, openCompare, branches, "head-branch", null);

    expect(requests[0].defaultValue).toBe("");
    requests[0].onSubmit("  ");
    expect(openCompare).not.toHaveBeenCalled();
    requests[0].onSubmit(" main ");
    expect(openCompare).toHaveBeenCalledWith(
      expect.objectContaining({ base: "main", head: "head-branch", scope: "branch" }),
    );
  });
});

describe("promptAnnotatedTag", () => {
  it("chains name → message (message defaults to the name) and creates at the sha", () => {
    const { requests, requestPrompt } = capturePrompt();
    const run = vi.fn((op: () => Promise<string>) => void op());
    const createAnnotatedTagAt = vi.fn(async () => "ok");
    promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, "abc123", "abc1234");

    expect(requests).toHaveLength(1);
    requests[0].onSubmit("v1.2.3");
    expect(requests).toHaveLength(2);
    expect(requests[1].title).toBe("Message for tag v1.2.3");
    expect(requests[1].defaultValue).toBe("v1.2.3");
    requests[1].onSubmit("release notes");
    expect(createAnnotatedTagAt).toHaveBeenCalledWith("v1.2.3", "release notes", "abc123");
  });
});
