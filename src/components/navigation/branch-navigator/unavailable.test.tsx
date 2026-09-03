// unify-error-model 4.3: a navigator section whose last read failed shows an
// explicit "Couldn't read <section>" row above its last good rows, instead of
// reading as an empty section.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StashEntry, WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { BranchNavigator } from "./BranchNavigator";
import { UnavailableRow } from "./rows";

const stash: StashEntry = {
  index: 0,
  message: "On main: kept stash",
  oid: "stash-oid",
  timestamp: 0,
  baseOid: "c1",
  baseTimestamp: 0,
  context: [],
};
const worktree: WorktreeInfo = { name: "wt", path: "/wt", branch: "feature", isMain: false };

beforeEach(() => {
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    graph: null,
    branches: [],
    worktrees: [],
    stashes: [],
    unavailableSections: {},
  });
  useUi.setState({ filter: "", navOpen: true, pinnedNavRefsByRepo: {} });
});

describe("UnavailableRow", () => {
  it("names the section and carries the error as its tooltip", () => {
    render(<UnavailableRow noun="stashes" message="git stash list: exit 128" />);
    const row = screen.getByRole("status");
    expect(row).toHaveTextContent("Couldn't read stashes");
    expect(row).toHaveAttribute("title", "git stash list: exit 128");
  });
});

describe("BranchNavigator — unavailable sections", () => {
  it("shows the unavailable row instead of the empty state when the stash read failed", () => {
    useRepo.setState({ unavailableSections: { stashes: "boom" } });
    render(<BranchNavigator />);

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't read stashes");
    expect(screen.queryByText("Nothing here yet")).not.toBeInTheDocument();
    expect(screen.queryByText(/No stashes yet/)).not.toBeInTheDocument();
  });

  it("keeps the last good stashes and worktrees under their unavailable rows", () => {
    useRepo.setState({
      stashes: [stash],
      worktrees: [worktree],
      unavailableSections: { stashes: "stash boom", worktrees: "worktree boom" },
    });
    render(<BranchNavigator />);

    const notices = screen.getAllByRole("status").map((el) => el.textContent);
    expect(notices).toEqual(["Couldn't read worktrees", "Couldn't read stashes"]);
    expect(screen.getByText("On main: kept stash")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
  });

  it("hides the notice while searching so the match count stays truthful", () => {
    useRepo.setState({ unavailableSections: { stashes: "boom" } });
    useUi.setState({ filter: "zzz" });
    render(<BranchNavigator />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/No ref matches/)).toBeInTheDocument();
  });
});
