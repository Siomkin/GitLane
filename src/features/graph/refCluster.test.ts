import { describe, it, expect } from "vitest";
import type { RefLabel } from "@/lib/api";
import { remoteBase, buildClusterItems } from "./refCluster";

const r = (name: string, kind: RefLabel["kind"]): RefLabel => ({ name, kind });

describe("remoteBase", () => {
  it("strips the remote name, keeping nested branch paths", () => {
    expect(remoteBase("origin/develop")).toBe("develop");
    expect(remoteBase("origin/feature/x")).toBe("feature/x");
    expect(remoteBase("develop")).toBe("develop");
  });
});

describe("buildClusterItems", () => {
  it("groups a local branch with its same-name remote", () => {
    const items = buildClusterItems([r("develop", "branch"), r("origin/develop", "remote")], "develop");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "group", base: "develop" });
    if (items[0].type === "group") {
      expect(items[0].local.name).toBe("develop");
      expect(items[0].remotes.map((x) => x.name)).toEqual(["origin/develop"]);
    }
  });

  it("groups multiple remotes of the same name into one item", () => {
    const items = buildClusterItems(
      [r("develop", "branch"), r("origin/develop", "remote"), r("upstream/develop", "remote")],
      null,
    );
    expect(items).toHaveLength(1);
    if (items[0].type === "group") expect(items[0].remotes).toHaveLength(2);
    else throw new Error("expected a group");
  });

  it("leaves a local-only branch and an unmatched remote as separate singles", () => {
    const items = buildClusterItems([r("feature", "branch"), r("origin/other", "remote")], null);
    expect(items.map((i) => i.type)).toEqual(["single", "single"]);
  });

  it("does not group a remote that has no local counterpart", () => {
    const items = buildClusterItems([r("origin/develop", "remote")], null);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("single");
  });

  it("orders the current branch's group first and tags last", () => {
    const items = buildClusterItems(
      [r("v1.0", "tag"), r("origin/main", "remote"), r("main", "branch")],
      "main",
    );
    expect(items[0]).toMatchObject({ type: "group", base: "main" });
    expect(items[items.length - 1]).toMatchObject({ type: "single", ref: { kind: "tag" } });
  });

  it("ignores HEAD pseudo-refs when grouping", () => {
    const items = buildClusterItems(
      [r("develop", "head"), r("develop", "branch"), r("origin/develop", "remote")],
      "develop",
    );
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("group");
  });
});
