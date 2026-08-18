import { describe, it, expect } from "vitest";

import { branchWebUrl, commitWebUrl } from "./forgeUrls";
import { ForgeKind, type RepoForge } from "./api";

const forge = (over: Partial<RepoForge>): RepoForge => ({
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
  ...over,
});

describe("branchWebUrl", () => {
  it("returns null when there's no web URL", () => {
    expect(branchWebUrl(null, "main")).toBeNull();
    expect(branchWebUrl(forge({ webUrl: null }), "main")).toBeNull();
  });

  it("uses per-forge tree paths", () => {
    expect(branchWebUrl(forge({ kind: ForgeKind.GitHub }), "main")).toBe(
      "https://github.com/o/r/tree/main",
    );
    expect(
      branchWebUrl(
        forge({ kind: ForgeKind.GitLab, webUrl: "https://gitlab.com/g/r", host: "gitlab.com" }),
        "main",
      ),
    ).toBe("https://gitlab.com/g/r/-/tree/main");
    expect(
      branchWebUrl(
        forge({ kind: ForgeKind.Bitbucket, webUrl: "https://bitbucket.org/t/r", host: "bitbucket.org" }),
        "main",
      ),
    ).toBe("https://bitbucket.org/t/r/branch/main");
    expect(
      branchWebUrl(
        forge({
          kind: ForgeKind.CursorOrigin,
          forge: "Cursor Origin",
          host: "origin.cursor.com",
          webUrl: "https://cursor.com/codebase/siomkin/lattice",
        }),
        "main",
      ),
    ).toBe("https://cursor.com/codebase/siomkin/lattice/tree/main");
  });

  it("preserves slashes in hierarchical branch names but escapes the rest", () => {
    expect(branchWebUrl(forge({}), "feature/new ui")).toBe(
      "https://github.com/o/r/tree/feature/new%20ui",
    );
  });

  it("strips a trailing slash on the repo URL and falls back to the root for unknown forges", () => {
    expect(branchWebUrl(forge({ webUrl: "https://github.com/o/r/" }), "main")).toBe(
      "https://github.com/o/r/tree/main",
    );
    expect(branchWebUrl(forge({ kind: null, forge: null }), "main")).toBe("https://github.com/o/r");
  });
});

describe("commitWebUrl", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("returns null when there's no web URL", () => {
    expect(commitWebUrl(null, sha)).toBeNull();
    expect(commitWebUrl(forge({ webUrl: null }), sha)).toBeNull();
  });

  it("uses per-forge commit paths", () => {
    expect(commitWebUrl(forge({ kind: ForgeKind.GitHub }), sha)).toBe(
      `https://github.com/o/r/commit/${sha}`,
    );
    expect(
      commitWebUrl(
        forge({ kind: ForgeKind.GitLab, webUrl: "https://gitlab.com/g/r", host: "gitlab.com" }),
        sha,
      ),
    ).toBe(`https://gitlab.com/g/r/-/commit/${sha}`);
    expect(
      commitWebUrl(
        forge({ kind: ForgeKind.Bitbucket, webUrl: "https://bitbucket.org/t/r", host: "bitbucket.org" }),
        sha,
      ),
    ).toBe(`https://bitbucket.org/t/r/commits/${sha}`);
    expect(
      commitWebUrl(
        forge({
          kind: ForgeKind.CursorOrigin,
          forge: "Cursor Origin",
          host: "origin.cursor.com",
          webUrl: "https://cursor.com/codebase/siomkin/lattice",
        }),
        sha,
      ),
    ).toBe(`https://cursor.com/codebase/siomkin/lattice/commit/${sha}`);
  });

  it("strips a trailing slash and falls back to the root for unknown forges", () => {
    expect(commitWebUrl(forge({ webUrl: "https://github.com/o/r/" }), sha)).toBe(
      `https://github.com/o/r/commit/${sha}`,
    );
    expect(commitWebUrl(forge({ kind: null, forge: null }), sha)).toBe("https://github.com/o/r");
  });
});
