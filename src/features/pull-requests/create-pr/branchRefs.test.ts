// The base field has two spellings of one target — the ref git resolves and the
// branch the forge is told — plus the order the list is offered in. These are
// the cases where the two diverge, or where an ordering key is missing.
import { describe, it, expect } from "vitest";
import type { BranchInfo } from "@/lib/api";
import { baseItems, branchNameOf, guessBase, readableRef, shortName } from "./branchRefs";

const local = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo =>
  ({ kind: "local", name, remote: null, ...extra }) as BranchInfo;
const remote = (name: string, remoteName = "origin"): BranchInfo =>
  ({ kind: "remote", name, remote: remoteName }) as BranchInfo;

describe("shortName", () => {
  it("strips only the branch's own recorded remote", () => {
    // A remote may itself contain a slash, so splitting on the first one turns
    // `my/fork/feature` into `fork/feature`.
    expect(shortName(remote("my/fork/release/2.4", "my/fork"))).toBe("release/2.4");
    expect(shortName(local("feature/x"))).toBe("feature/x");
  });
});

describe("baseItems", () => {
  it("orders by tip recency, alphabetically among branches sharing a tip", () => {
    const rows = baseItems(
      [
        local("feat/x", { tipTime: 500 }),
        local("zzz", { tipTime: 300 }),
        local("aaa", { tipTime: 300 }),
        local("newest", { tipTime: 400 }),
      ],
      "feat/x",
    );
    expect(rows.map((r) => r.value)).toEqual(["newest", "aaa", "zzz"]);
  });

  it("sinks a branch whose tip could not be read below every dated one", () => {
    // Not a 0: an unresolvable tip is unknown, and treating it as the epoch
    // would be right only by accident — treating it as *now* would be wrong
    // every time, which is what jumping to the top amounts to.
    const rows = baseItems(
      [local("feat/x", { tipTime: 900 }), local("undated"), local("old", { tipTime: 1 })],
      "feat/x",
    );
    expect(rows.map((r) => r.value)).toEqual(["old", "undated"]);
  });

  it("drops a remote already offered under the same local name", () => {
    const rows = baseItems(
      [local("feat/x"), local("develop", { tipTime: 2 }), remote("origin/develop"), remote("origin/only-remote")],
      "feat/x",
    );
    expect(rows.map((r) => `${r.value}:${r.hint ?? ""}`)).toEqual([
      "develop:",
      "origin/only-remote:remote",
    ]);
  });
});

describe("readableRef / branchNameOf", () => {
  it("reads through the remote-tracking ref but tells the forge the branch", () => {
    // `default_base_branch` answers `main`; with the branch never checked out,
    // only `origin/main` resolves locally — and `--base origin/main` is not a
    // thing on the forge side.
    const branches = [local("feat/x"), remote("origin/main")];
    expect(readableRef(branches, "main")).toBe("origin/main");
    expect(branchNameOf(branches, "origin/main")).toBe("main");
  });

  it("leaves a ref it does not recognise alone", () => {
    // Half-typed input reaches here; inventing a resolution would be worse than
    // letting the read fail honestly.
    expect(readableRef([local("feat/x")], "rele")).toBe("rele");
    expect(branchNameOf([local("feat/x")], "rele")).toBe("rele");
  });
});

describe("guessBase", () => {
  it("prefers a conventional name, local or remote-only", () => {
    expect(guessBase([local("feat/x"), local("chore/a"), local("develop")], "feat/x")).toBe("develop");
    expect(guessBase([local("feat/x"), remote("origin/main")], "feat/x")).toBe("origin/main");
  });

  it("falls back to the newest other local branch", () => {
    expect(
      guessBase(
        [local("feat/x", { tipTime: 9 }), local("chore/a", { tipTime: 1 }), local("chore/b", { tipTime: 5 })],
        "feat/x",
      ),
    ).toBe("chore/b");
  });

  it("returns nothing rather than a branch that does not exist", () => {
    // The old fallback was the literal "main". A base nobody verified reads as
    // a confident answer, fails the range read, and then fails at the forge;
    // empty leaves the field visibly unset and blocks submit.
    expect(guessBase([local("feat/x")], "feat/x")).toBe("");
    expect(guessBase([], "feat/x")).toBe("");
  });
});
