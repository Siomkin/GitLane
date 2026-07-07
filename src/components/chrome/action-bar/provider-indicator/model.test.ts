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

  it("drops the count from the view-PRs primary when there are no open PRs", () => {
    expect(providerPopoverModel("connected", forge(), 0).primary?.label).toBe("View pull requests");
  });

  it("needs-auth: sign-in pill + key primary, still links to github sections", () => {
    const m = providerPopoverModel("needs-auth", forge(), 0);
    expect(m.capability?.label).toBe("Sign in");
    expect(m.primary).toMatchObject({ icon: "key", label: "Sign in to GitHub", action: { kind: "sign-in" } });
    expect(m.note).toMatch(/no account is bound/i);
    expect(m.githubEyebrow).toBe("On github.com");
    expect(m.settings).not.toBeNull();
  });

  const gitlab = () =>
    forge({ kind: ForgeKind.GitLab, forge: "GitLab", host: "gitlab.com", webUrl: "https://gitlab.com/siomkin/gitlane" });

  it("connected GitLab: MRs-on pill, view-MRs primary, GitLab /-/ links, no settings (GL-145)", () => {
    const m = providerPopoverModel("connected", gitlab(), 3);
    expect(m.headerIcon).toBe("gitlab");
    expect(m.title).toBe("siomkin/gitlane");
    expect(m.capability).toEqual({ label: "MRs on", tone: expect.stringContaining("emerald") });
    expect(m.primary).toMatchObject({ label: "View 3 merge requests", suffix: "→", action: { kind: "view-prs" } });
    expect(m.githubEyebrow).toBe("On gitlab.com");
    expect(m.githubLinks.map((l) => l.href)).toEqual([
      "https://gitlab.com/siomkin/gitlane/-/merge_requests",
      "https://gitlab.com/siomkin/gitlane/-/issues",
    ]);
    expect(m.githubLinks[0].label).toBe("Merge requests (3)");
    expect(m.settings).toBeNull();
  });

  it("singularises the view-MRs primary for one open MR", () => {
    expect(providerPopoverModel("connected", gitlab(), 1).primary?.label).toBe("View 1 merge request");
  });

  it("needs-auth GitLab: sign-in pill + glab/token guidance, key primary (GL-145)", () => {
    const m = providerPopoverModel("needs-auth", gitlab(), 0);
    expect(m.headerIcon).toBe("gitlab");
    expect(m.capability?.label).toBe("Sign in");
    expect(m.primary).toMatchObject({ icon: "key", label: "Sign in to GitLab", action: { kind: "sign-in" } });
    expect(m.note).toMatch(/glab or a token/i);
  });

  it("connected non-PR forge (Bitbucket): no-PRs shape, open-on-forge primary, no link sections", () => {
    const m = providerPopoverModel(
      "connected",
      forge({ kind: ForgeKind.Bitbucket, forge: "Bitbucket", host: "bitbucket.org", webUrl: "https://bitbucket.org/team/app" }),
      0,
    );
    expect(m.headerIcon).toBe("bitbucket");
    expect(m.capability?.label).toBe("No PRs");
    expect(m.note).toMatch(/aren't available for Bitbucket remotes/);
    expect(m.primary).toMatchObject({ icon: "external", label: "Open on Bitbucket", suffix: "↗" });
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

  it("error: static rose header, set-up-gh primary linking to cli.github.com", () => {
    const m = providerPopoverModel("error", forge(), 0);
    expect(m.headerIcon).toBe("warning");
    expect(m.title).toBe("GitHub CLI unavailable");
    expect(m.headHref).toBeNull();
    expect(m.capability?.label).toBe("Error");
    expect(m.primary).toMatchObject({ label: "Set up gh", action: { kind: "open-url", url: "https://cli.github.com" } });
  });

  it("error: surfaces the real failure reason as the subtitle (strips an 'Error:' prefix)", () => {
    const m = providerPopoverModel("error", forge(), 0, "Error: gh version 2.40 is below the 2.95 baseline");
    expect(m.host).toBe("gh version 2.40 is below the 2.95 baseline");
  });

  it("error: falls back to a generic subtitle when no detail is given", () => {
    expect(providerPopoverModel("error", forge(), 0).host).toBe("Provider unavailable");
  });
});
