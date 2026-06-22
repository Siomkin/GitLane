import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { RepoIdentityPanel } from "./RepoIdentityPanel";

const repoPath = "repo-under-test";
const summary: RepoSummary = {
  path: repoPath,
  workdir: repoPath,
  headBranch: "main",
  headOid: "abc123",
  detached: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useRepo.setState({ summary });
  useAccounts.setState({ accounts: [], repoAccountId: null, repoAccountRef: null, repoIdentity: null });
});

describe("RepoIdentityPanel", () => {
  it("prompts to open a repo when none is loaded", () => {
    useRepo.setState({ summary: null });
    render(<RepoIdentityPanel />);
    expect(
      screen.getByText("Open a repository to choose the account it commits, fetches, and pushes as."),
    ).toBeInTheDocument();
  });

  it("keeps Save disabled until the identity is dirty and valid", () => {
    render(<RepoIdentityPanel />);
    const save = screen.getByRole("button", { name: "Save identity" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "not-an-email" } });
    expect(save).toBeDisabled(); // dirty but invalid email

    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "ada@example.com" } });
    expect(save).toBeEnabled();
  });

  it("persists a valid identity through the accounts store", () => {
    render(<RepoIdentityPanel />);
    fireEvent.change(screen.getByLabelText("NAME"), { target: { value: "  Ada  " } });
    fireEvent.change(screen.getByLabelText("EMAIL"), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));

    // Store is updated synchronously (trimmed) and mirrored to git config via IPC.
    expect(useAccounts.getState().repoIdentity).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(invokeMock).toHaveBeenCalledWith("set_repo_identity", {
      path: repoPath,
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("renders the account choices as a radiogroup with the bound account checked", () => {
    useAccounts.setState({
      accounts: [
        {
          id: "gh:github.com:583231",
          forge: "GitHub",
          provider: "gh",
          host: "github.com",
          accountId: "583231",
          login: "octocat",
          label: "octocat",
          username: "octocat",
          name: "Octo Cat",
          email: "octo@example.com",
          color: "#f00",
          ref: { provider: "gh", host: "github.com", accountId: "583231", login: "octocat" },
          active: true,
        },
      ],
      repoAccountId: "gh:github.com:583231",
      repoAccountRef: { provider: "gh", host: "github.com", accountId: "583231", login: "octocat" },
    });
    render(<RepoIdentityPanel />);

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    const bound = screen.getByRole("radio", { name: /@octocat/ });
    expect(bound).toHaveAttribute("aria-checked", "true");
    const none = screen.getByRole("radio", { name: /No identity/ });
    expect(none).toHaveAttribute("aria-checked", "false");
  });
});
