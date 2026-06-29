import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { RepoSummary } from "@/lib/api";
import type { GitProfile } from "@/lib/profiles";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useProfiles } from "@/store/profiles";
import { IdentityChip } from "./IdentityChip";

const path = "repo-under-test";
const summary: RepoSummary = { path, workdir: path, headBranch: "main", headOid: "abc", detached: false };

const personal: GitProfile = { id: "p1", label: "Personal", name: "Stepan Personal", email: "personal@x.dev", color: "#5b8def" };
const work: GitProfile = { id: "p2", label: "Work", name: "Stepan Work", email: "work@acme.io", color: "#2f9e7e" };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("gitlane.profiles", JSON.stringify([personal, work]));
  localStorage.setItem("gitlane.repoProfile", JSON.stringify({ [path]: "p2" }));
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  useRepo.setState({ summary });
  useAccounts.setState({
    accounts: [],
    repoAccountId: null,
    repoIdentity: { name: "Stepan Work", email: "work@acme.io" },
  });
  useProfiles.setState({ profiles: [], defaultIdentity: null });
});

describe("IdentityChip", () => {
  it("leads with the commit identity (applied profile), not the account", () => {
    render(<IdentityChip />);
    expect(screen.getByTitle("Commit identity for this repository")).toHaveTextContent("Work");
  });

  it("opens a profile quick-switch with the PR account as a secondary line", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    expect(screen.getByText("COMMIT IDENTITY")).toBeInTheDocument();
    expect(screen.getByText("Default git identity")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    // The account is present but subordinate.
    expect(screen.getByText("PR ACCOUNT")).toBeInTheDocument();
  });

  it("applies a profile on click (writes the commit identity)", () => {
    render(<IdentityChip />);
    fireEvent.click(screen.getByTitle("Commit identity for this repository"));
    fireEvent.click(screen.getByText("Personal"));
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path, name: "Stepan Personal", email: "personal@x.dev" }),
    );
  });
});
