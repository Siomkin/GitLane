import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RemoteInfo } from "@/lib/api";
import { RemoteSummaryCard } from "./RemoteSummaryCard";

// The card's readiness follows the account label it's given (`prsReady = prs &&
// Boolean(accountLabel)`); its copy is forge-aware (GL-145). `accountLabel` is
// resolved per-forge by RemotesPanel — GitLab from glab/token, GitHub from gh.
const remote = (url: string): RemoteInfo => ({ name: "origin", fetchUrl: url, pushUrl: url, isDefault: true });

describe("RemoteSummaryCard", () => {
  it("GitHub with a bound account → pull requests enabled", () => {
    render(<RemoteSummaryCard remote={remote("https://github.com/me/repo.git")} accountLabel="@octocat" />);
    expect(screen.getByText("Pull requests enabled")).toBeInTheDocument();
    expect(screen.getByText("@octocat")).toBeInTheDocument();
  });

  it("GitLab with a glab/token account → merge requests enabled (GL-145)", () => {
    render(<RemoteSummaryCard remote={remote("https://gitlab.com/group/repo.git")} accountLabel="@ada" />);
    expect(screen.getByText("Merge requests enabled")).toBeInTheDocument();
    expect(screen.getByText("@ada")).toBeInTheDocument();
  });

  it("GitLab with no account → 'Sign in for merge requests', not the gh-only 'Select account for PRs'", () => {
    render(<RemoteSummaryCard remote={remote("https://gitlab.com/group/repo.git")} accountLabel={null} />);
    expect(screen.getByText("Sign in for merge requests")).toBeInTheDocument();
    expect(screen.queryByText("Select account for PRs")).toBeNull();
  });

  it("Bitbucket with a token account → pull requests enabled (GL-141)", () => {
    render(<RemoteSummaryCard remote={remote("https://bitbucket.org/team/repo.git")} accountLabel="@ada" />);
    expect(screen.getByText("Pull requests enabled")).toBeInTheDocument();
    expect(screen.getByText("@ada")).toBeInTheDocument();
  });

  it("Bitbucket with no account → 'Sign in for pull requests', not the gh-only 'Select account for PRs' (GL-141)", () => {
    render(<RemoteSummaryCard remote={remote("https://bitbucket.org/team/repo.git")} accountLabel={null} />);
    expect(screen.getByText("Sign in for pull requests")).toBeInTheDocument();
    expect(screen.queryByText("Select account for PRs")).toBeNull();
  });

  it("a non-PR forge → pull requests unavailable", () => {
    render(<RemoteSummaryCard remote={remote("https://dev.azure.com/org/proj/_git/repo")} accountLabel={null} />);
    expect(screen.getByText("Pull requests unavailable")).toBeInTheDocument();
  });
});
