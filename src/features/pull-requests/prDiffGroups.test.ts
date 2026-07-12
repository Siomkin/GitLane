import { describe, it, expect } from "vitest";
import type { FileDiff } from "@/lib/api/git";
import { groupByCommit, showCommitHeaders } from "./prDiffGroups";

const fileDiff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: "src/one.txt",
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  hunks: [],
  truncated: false,
  ...over,
});

const OID_A = "aaaaaaa1111111111111111111111111111111111";
const OID_B = "bbbbbbb2222222222222222222222222222222222";

describe("groupByCommit", () => {
  it("returns no groups for an empty diff", () => {
    expect(groupByCommit([])).toEqual([]);
    expect(showCommitHeaders([])).toBe(false);
  });

  it("collapses a single-commit PR into one group (headers stay off)", () => {
    const diffs = [
      fileDiff({ commitOid: OID_A, commitSubject: "feat: only commit" }),
      fileDiff({ path: "src/other.txt", commitOid: OID_A, commitSubject: "feat: only commit" }),
    ];
    const groups = groupByCommit(diffs);

    expect(groups).toHaveLength(1);
    expect(groups[0].oid).toBe(OID_A);
    expect(groups[0].subject).toBe("feat: only commit");
    expect(groups[0].files.map((f) => f.file.path)).toEqual(["src/one.txt", "src/other.txt"]);
    expect(showCommitHeaders(groups)).toBe(false);
  });

  it("splits consecutive commit segments into ordered groups (headers on)", () => {
    const diffs = [
      fileDiff({ commitOid: OID_A, commitSubject: "feat: first" }),
      fileDiff({ path: "src/two.txt", commitOid: OID_A, commitSubject: "feat: first" }),
      fileDiff({ path: "src/three.txt", commitOid: OID_B, commitSubject: "fix: second" }),
    ];
    const groups = groupByCommit(diffs);

    expect(groups.map((g) => g.oid)).toEqual([OID_A, OID_B]);
    expect(groups[0].files).toHaveLength(2);
    expect(groups[1].files).toHaveLength(1);
    expect(showCommitHeaders(groups)).toBe(true);
  });

  it("keeps global indices so repeated paths across commits get distinct keys", () => {
    // The same path touched by two commits appears once per commit (GL-112);
    // the index is the file's position in the flat list, not within its group.
    const diffs = [
      fileDiff({ commitOid: OID_A, commitSubject: "feat: first" }),
      fileDiff({ commitOid: OID_B, commitSubject: "fix: second" }),
    ];
    const groups = groupByCommit(diffs);

    expect(groups).toHaveLength(2);
    expect(groups[0].files[0]).toMatchObject({ index: 0, file: { path: "src/one.txt" } });
    expect(groups[1].files[0]).toMatchObject({ index: 1, file: { path: "src/one.txt" } });
  });

  it("collapses attribution-less diffs into one headerless group", () => {
    const groups = groupByCommit([fileDiff(), fileDiff({ path: "src/other.txt" })]);

    expect(groups).toHaveLength(1);
    expect(groups[0].oid).toBeUndefined();
    expect(groups[0].subject).toBeUndefined();
    expect(groups[0].files).toHaveLength(2);
    expect(showCommitHeaders(groups)).toBe(false);
  });

  it("keeps mixed attribution as separate groups, attribution-less first", () => {
    // Documents the guard: a real gh patch never mixes attributed and
    // unattributed files, but if one did, the unattributed run is its own
    // (headerless) group and headers turn on for the attributed one.
    const groups = groupByCommit([
      fileDiff(),
      fileDiff({ path: "src/other.txt", commitOid: OID_A, commitSubject: "fix: attributed" }),
    ]);

    expect(groups.map((g) => g.oid)).toEqual([undefined, OID_A]);
    expect(showCommitHeaders(groups)).toBe(true);
  });

  it("starts a NEW group when an oid reappears after another commit (non-contiguous segments)", () => {
    // Grouping is by consecutive runs, mirroring the patch's segment order —
    // an oid resurfacing later must NOT be merged back into its earlier group.
    const diffs = [
      fileDiff({ commitOid: OID_A, commitSubject: "feat: first" }),
      fileDiff({ path: "src/two.txt", commitOid: OID_B, commitSubject: "fix: second" }),
      fileDiff({ path: "src/three.txt", commitOid: OID_A, commitSubject: "feat: first" }),
    ];
    const groups = groupByCommit(diffs);

    expect(groups.map((g) => g.oid)).toEqual([OID_A, OID_B, OID_A]);
    expect(groups[2].files[0]).toMatchObject({ index: 2, file: { path: "src/three.txt" } });
  });
});
