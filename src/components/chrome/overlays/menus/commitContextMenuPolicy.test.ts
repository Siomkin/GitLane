import { describe, expect, it } from "vitest";
import { ForgeKind, RefKind, type CommitNode, type RepoForge, type RepoGraph } from "@/lib/api";
import { deriveCommitContextMenuPolicy } from "./commitContextMenuPolicy";

const commit = (over: Partial<CommitNode> & { id: string }): CommitNode => ({
  shortId: over.id.slice(0, 7),
  summary: `subject ${over.id}`,
  body: "",
  authorName: "A",
  authorEmail: "a@example.com",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...over,
});

// A two-commit chain: `remote` (carries a remote ref) → `local` (its child, tip).
const chainGraph = (over: Partial<RepoGraph> = {}): RepoGraph => ({
  commits: [
    commit({ id: "local", parents: ["remote"] }),
    commit({ id: "remote", refs: [{ kind: RefKind.Remote, name: "origin/main" }] }),
  ],
  edges: [],
  laneCount: 1,
  head: "local",
  truncated: false,
  ...over,
});

const forge = (over: Partial<RepoForge> = {}): RepoForge => ({
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
  ...over,
});

const input = (over: Partial<Parameters<typeof deriveCommitContextMenuPolicy>[0]> = {}) => ({
  sha: "local",
  shortSha: "local",
  graph: chainGraph(),
  forge: forge(),
  headBranch: "main",
  selectedCommit: null,
  ...over,
});

describe("deriveCommitContextMenuPolicy", () => {
  it("resolves subject and body from the graph, falling back to the short sha", () => {
    const withBody = deriveCommitContextMenuPolicy(
      input({ graph: chainGraph({ commits: [commit({ id: "local", summary: "hi", body: "detail" })] }) }),
    );
    expect(withBody.subject).toBe("hi");
    expect(withBody.body).toBe("detail");

    const missing = deriveCommitContextMenuPolicy(input({ sha: "ghost", shortSha: "ghost1" }));
    expect(missing.subject).toBe("ghost1");
    expect(missing.body).toBe("");
  });

  it("offers reword only for the local-only HEAD", () => {
    expect(deriveCommitContextMenuPolicy(input({ sha: "local", shortSha: "local" })).canRewordHead).toBe(true);
    // The remote-reachable commit is not rewordable even though it's HEAD's ancestor.
    expect(
      deriveCommitContextMenuPolicy(input({ sha: "remote", shortSha: "remote", graph: chainGraph({ head: "remote" }) }))
        .canRewordHead,
    ).toBe(false);
    // Detached HEAD (no branch) can't reword.
    expect(deriveCommitContextMenuPolicy(input({ headBranch: null })).canRewordHead).toBe(false);
  });

  it("builds a forge commit URL only when the commit is remote-reachable", () => {
    // `remote` carries the remote ref → reachable → URL present.
    const reachable = deriveCommitContextMenuPolicy(input({ sha: "remote", shortSha: "remote" }));
    expect(reachable.forgeCommitUrl).toBe("https://github.com/o/r/commit/remote");
    expect(reachable.forgeName).toBe("GitHub");

    // `local` is unpushed (not reachable from any remote ref) → no URL.
    expect(deriveCommitContextMenuPolicy(input({ sha: "local", shortSha: "local" })).forgeCommitUrl).toBeNull();
  });

  it("hides the forge URL when there is no forge web URL", () => {
    const p = deriveCommitContextMenuPolicy(
      input({ sha: "remote", shortSha: "remote", forge: forge({ webUrl: null, kind: null, forge: null }) }),
    );
    expect(p.forgeCommitUrl).toBeNull();
  });

  it("hides the forge URL for an unrecognised host even when it has a web URL", () => {
    // An unknown forge reports kind: null but often still a webUrl; commitWebUrl
    // would fall back to the repo root, so the affordance must stay hidden.
    const p = deriveCommitContextMenuPolicy(
      input({
        sha: "remote",
        shortSha: "remote",
        forge: forge({ kind: null, forge: null, webUrl: "https://git.example.com/o/r" }),
      }),
    );
    expect(p.forgeCommitUrl).toBeNull();
    expect(p.forgeName).toBeNull();
  });

  it("reports another selected commit for the compare row", () => {
    expect(deriveCommitContextMenuPolicy(input({ selectedCommit: "remote" })).otherSelected).toBe("remote");
    // Selecting the same commit is not "another".
    expect(deriveCommitContextMenuPolicy(input({ selectedCommit: "local" })).otherSelected).toBeNull();
    expect(deriveCommitContextMenuPolicy(input({ selectedCommit: null })).otherSelected).toBeNull();
  });
});
