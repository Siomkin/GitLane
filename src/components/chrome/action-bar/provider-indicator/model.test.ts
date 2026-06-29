import { describe, expect, it } from "vitest";
import { ForgeKind } from "../../../../lib/api";
import type { RepoForge } from "../../../../lib/api";
import { providerPopoverModel } from "./model";

const forge = (over: Partial<RepoForge> = {}): RepoForge => ({
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/Siomkin/GitLane",
  ...over,
});

describe("providerPopoverModel", () => {
  it("connected GitHub: repo link header, PRs-on pill, view-PRs primary, github + settings links", () => {
    const m = providerPopoverModel("connected", forge(), 7);
    expect(m.headerIcon).toBe("github");
    expect(m.title).toBe("Siomkin/GitLane");
    expect(m.host).toBe("github.com");
    expect(m.headHref).toBe("https://github.com/Siomkin/GitLane");
    expect(m.capability).toEqual({ label: "PRs on", tone: expect.stringContaining("emerald") });
    expect(m.primary).toMatchObject({ label: "View 7 pull requests", suffix: "→", action: { kind: "view-prs" } });
    expect(m.githubEyebrow).toBe("On github.com");
    expect(m.githubLinks.map((l) => l.href)).toEqual([
      "https://github.com/Siomkin/GitLane/pulls",
      "https://github.com/Siomkin/GitLane/issues",
    ]);
    expect(m.githubLinks[0].label).toBe("Pull requests (7)");
    expect(m.settings?.links.map((l) => l.href)).toEqual([
      "https://github.com/Siomkin/GitLane/settings",
      "https://github.com/Siomkin/GitLane/settings/branches",
      "https://github.com/Siomkin/GitLane/settings/access",
      "https://github.com/Siomkin/GitLane/settings/hooks",
    ]);
  });

  it("singularises the view-PRs primary for one open PR", () => {
    expect(providerPopoverModel("connected", forge(), 1).primary?.label).toBe("View 1 pull request");
  });

  it("needs-auth: sign-in pill + key primary, still links to github sections", () => {
    const m = providerPopoverModel("needs-auth", forge(), 0);
    expect(m.capability?.label).toBe("Sign in");
    expect(m.primary).toMatchObject({ icon: "key", label: "Sign in to GitHub", action: { kind: "sign-in" } });
    expect(m.note).toMatch(/no account is bound/i);
    expect(m.githubEyebrow).toBe("On github.com");
    expect(m.settings).not.toBeNull();
  });

  it("connected non-GitHub forge (GitLab): no-PRs shape, brand icon, open-on-forge primary, no github sections", () => {
    const m = providerPopoverModel(
      "connected",
      forge({ kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/siomkin/gitlane" }),
      0,
    );
    expect(m.headerIcon).toBe("gitlab");
    expect(m.title).toBe("siomkin/gitlane");
    expect(m.capability?.label).toBe("No PRs");
    expect(m.note).toMatch(/aren't available for GitLab remotes/);
    expect(m.primary).toMatchObject({ icon: "external", label: "Open on GitLab", suffix: "↗" });
    expect(m.primary?.action).toEqual({ kind: "open-url", url: "https://gitlab.com/siomkin/gitlane" });
    expect(m.githubEyebrow).toBeNull();
    expect(m.settings).toBeNull();
  });

  it("unsupported host: generic cloud icon, no-PRs shape", () => {
    const m = providerPopoverModel(
      "unsupported",
      forge({ kind: null, forge: null, host: "git.internal.example", webUrl: "https://git.internal.example/team/app" }),
      0,
    );
    expect(m.headerIcon).toBe("cloud");
    expect(m.headHref).toBe("https://git.internal.example/team/app");
    expect(m.note).toMatch(/aren't available for git.internal.example remotes/);
    expect(m.primary?.action).toEqual({ kind: "open-url", url: "https://git.internal.example/team/app" });
  });

  it("forge with no web URL drops the primary button (nothing external to open)", () => {
    const m = providerPopoverModel("unsupported", forge({ kind: null, forge: null, host: "scm.example", webUrl: null }), 0);
    expect(m.headHref).toBeNull();
    expect(m.primary).toBeNull();
  });

  it("missing: static header, add-remote primary, no capability pill", () => {
    const m = providerPopoverModel("missing", forge({ hasRemote: false, kind: null, forge: null, host: null, webUrl: null }), 0);
    expect(m.headerIcon).toBe("cloudOff");
    expect(m.headHref).toBeNull();
    expect(m.capability).toBeNull();
    expect(m.primary).toMatchObject({ icon: "plus", label: "Add a remote…", action: { kind: "add-remote" } });
  });

  it("error: static rose header, install-gh primary linking to cli.github.com", () => {
    const m = providerPopoverModel("error", forge(), 0);
    expect(m.headerIcon).toBe("warning");
    expect(m.headHref).toBeNull();
    expect(m.capability?.label).toBe("Error");
    expect(m.primary?.action).toEqual({ kind: "open-url", url: "https://cli.github.com" });
  });
});
