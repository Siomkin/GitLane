import { describe, expect, it } from "vitest";
import type { PullRequest } from "@/lib/prs";
import {
  STACK_ROW_KIND,
  mergeOrderNote,
  stackCandidates,
  stackChain,
  stackMapRows,
  stackParent,
} from "./prTargets";

function pr(num: number, branch: string, base: string, extra: Partial<PullRequest> = {}) {
  return { num, branch, base, draft: false, age: "2d", ...extra } as PullRequest;
}

describe("stackCandidates", () => {
  it("asks about the remote-tracking ref, which is what an open PR's head is", () => {
    const byRef = stackCandidates([pr(1, "fix/a", "develop")], "origin", "feature/top");
    expect([...byRef.keys()]).toEqual(["origin/fix/a"]);
    expect(byRef.get("origin/fix/a")?.num).toBe(1);
  });

  it("omits the pull request already open on the current branch", () => {
    // Nothing stacks on itself, and offering it would let someone target their
    // own branch as a base.
    const byRef = stackCandidates([pr(1, "feature/top", "develop")], "origin", "feature/top");
    expect(byRef.size).toBe(0);
  });

  it("offers nothing when the repo has no remote — no PR head to compare against", () => {
    expect(stackCandidates([pr(1, "fix/a", "develop")], null, "feature/top").size).toBe(0);
  });
});

describe("stackParent", () => {
  it("picks the nearest ancestor that is an open pull request", () => {
    const lower = pr(141, "fix/scroll", "develop");
    const byRef = stackCandidates([lower], "origin", "feature/top");
    // The probe returns nearest-first; `develop` is an ancestor too but has no
    // open pull request, so it is not a stack parent.
    const found = stackParent(["origin/fix/scroll", "origin/develop"], byRef);
    expect(found?.pr).toBe(lower);
    // The ref that resolved is kept, so local reads use the tracking ref even
    // when the branch was never checked out here.
    expect(found?.ref).toBe("origin/fix/scroll");
  });

  it("returns null when no ancestor has an open pull request", () => {
    const byRef = stackCandidates([pr(141, "fix/scroll", "develop")], "origin", "feature/top");
    expect(stackParent(["origin/develop"], byRef)).toBeNull();
  });
});

describe("stackChain", () => {
  it("follows base -> head links down to the trunk", () => {
    const top = pr(143, "perf/lane-cache", "fix/scroll");
    const bottom = pr(141, "fix/scroll", "develop");
    const chain = stackChain(top, [top, bottom]);
    expect(chain.map((p) => p.num)).toEqual([143, 141]);
    expect(chain[chain.length - 1].base).toBe("develop");
  });

  it("stops instead of looping when two pull requests target each other", () => {
    const a = pr(1, "a", "b");
    const b = pr(2, "b", "a");
    expect(stackChain(a, [a, b]).map((p) => p.num)).toEqual([1, 2]);
  });
});

describe("stackMapRows", () => {
  it("draws the new pull request on top, layers below, trunk last", () => {
    const rows = stackMapRows({
      head: "feature/top",
      chain: [pr(143, "perf/lane-cache", "fix/scroll", { draft: true }), pr(141, "fix/scroll", "develop")],
      trunk: "develop",
      commitCount: 2,
      createdNumber: null,
    });
    expect(rows.map((r) => [r.kind, r.branch, r.layer, r.isDraft])).toEqual([
      [STACK_ROW_KIND.New, "feature/top", "L3", false],
      [STACK_ROW_KIND.Layer, "perf/lane-cache", "L2", true],
      [STACK_ROW_KIND.Layer, "fix/scroll", "L1", false],
      [STACK_ROW_KIND.Trunk, "develop", "", false],
    ]);
    expect(rows[0].meta).toBe("2 commits");
  });

  it("degenerates to new-over-base with no layer labels when not stacked", () => {
    const rows = stackMapRows({
      head: "feature/top",
      chain: [],
      trunk: "develop",
      commitCount: 1,
      createdNumber: null,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].layer).toBe("");
    expect(rows[0].meta).toBe("1 commit");
  });

  it("shows the number once the pull request exists", () => {
    const rows = stackMapRows({
      head: "feature/top",
      chain: [],
      trunk: "develop",
      commitCount: 3,
      createdNumber: 144,
    });
    expect(rows[0].num).toBe("#144");
  });
});

describe("mergeOrderNote", () => {
  it("names the layers bottom-up, which is the order they land in", () => {
    const note = mergeOrderNote([pr(143, "perf/lane-cache", "fix/scroll"), pr(141, "fix/scroll", "develop")]);
    expect(note).toBe("Merges bottom-up: #141, #143, then this one.");
  });

  it("says nothing when there is no stack", () => {
    expect(mergeOrderNote([])).toBe("");
  });
});
