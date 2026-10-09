import { describe, expect, it } from "vitest";
import { summaryToPr } from "@/lib/prs";
import type { PullRequestSummary } from "@/lib/api";
import { stateView } from "./prState";

const summary = (state: string): PullRequestSummary => ({
  number: 1,
  title: "t",
  state,
  headRef: "h",
  baseRef: "b",
  author: { login: "a", name: "A" },
  createdAt: "2026-01-01T00:00:00Z",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  isDraft: false,
  url: "",
  mergeable: "UNKNOWN",
});

describe("stateView", () => {
  it("labels an unrecognised forge state with its raw value, not Closed", () => {
    expect(stateView(summaryToPr(summary("QUEUED"))).label).toBe("Queued");
    expect(stateView(summaryToPr(summary("MERGE_QUEUED"))).label).toBe("Merge queued");
  });

  it("keeps the known labels", () => {
    expect(stateView(summaryToPr(summary("CLOSED"))).label).toBe("Closed");
    expect(stateView(summaryToPr(summary("OPEN"))).label).toBe("Open");
  });
});
