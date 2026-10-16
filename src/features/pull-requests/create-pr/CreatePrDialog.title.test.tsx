// The dialog's title defaults to the head branch's last commit subject — the
// newest commit `range_commits` returns — filled once per open and never over
// text the user typed or cleared.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { CreatePrDialog } from "./CreatePrDialog";

const commit = (id: string, summary: string) => ({
  id,
  shortId: id.padEnd(7, "0"),
  summary,
  authorName: "",
  authorEmail: "",
  timestamp: 0,
});

/** Stub the mount reads; `range` answers `range_commits` (a promise to hold it). */
function stubReads(range: (args: { base: string }) => Promise<unknown>) {
  invokeMock.mockImplementation((command: string, args: { base: string }) => {
    switch (command) {
      case "range_commits":
        return range(args);
      case "compare_refs":
        return Promise.resolve({ files: [], add: 0, del: 0, ahead: 0, behind: 0 });
      case "default_base_branch":
        return Promise.resolve("develop");
      case "list_repo_files":
        return Promise.resolve({ paths: [], truncated: false });
      case "ancestor_refs":
      case "pull_request_reviewer_candidates":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  });
}

const title = () => screen.getByPlaceholderText("Title");

beforeEach(() => {
  invokeMock.mockReset();
  usePulls.setState({ prPendingActions: [], pullRequests: [] });
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "feature/x",
      headOid: "aaa",
      detached: false,
      unborn: false,
      isWorktree: false,
    },
    branches: [
      { kind: "local", name: "feature/x", upstream: "origin/feature/x" },
      { kind: "local", name: "develop" },
      { kind: "local", name: "main" },
    ] as never,
    forge: null,
  });
  useUi.setState({ createPrOpen: false, createPrGeneration: 0 });
  useUi.getState().openCreatePr();
});

describe("CreatePrDialog default title", () => {
  it("fills the title with the newest commit's subject", async () => {
    stubReads(() =>
      Promise.resolve({
        commits: [commit("b", "Add profile tab"), commit("a", "Earlier work")],
        truncated: false,
      }),
    );
    render(<CreatePrDialog />);

    await waitFor(() => expect(title()).toHaveValue("Add profile tab"));
    await userEvent.type(title(), "!");
    expect(title()).toHaveValue("Add profile tab!");
  });

  it("keeps a title typed before the commits loaded", async () => {
    let release!: (range: unknown) => void;
    stubReads(() => new Promise((r) => (release = r)));
    render(<CreatePrDialog />);

    await userEvent.type(title(), "WIP: profile");
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => release({ commits: [commit("b", "Add profile tab")], truncated: false }));

    expect(title()).toHaveValue("WIP: profile");
  });

  it("does not refill a cleared title when the base changes", async () => {
    // `main` is further behind, so its range is visibly different once loaded.
    stubReads(({ base }) =>
      Promise.resolve({
        commits:
          base === "main"
            ? [commit("b", "Add profile tab"), commit("a", "Earlier work")]
            : [commit("b", "Add profile tab")],
        truncated: false,
      }),
    );
    render(<CreatePrDialog />);
    await waitFor(() => expect(title()).toHaveValue("Add profile tab"));

    await userEvent.clear(title());
    const base = screen.getByLabelText("Base branch");
    await userEvent.clear(base);
    await userEvent.type(base, "main");
    await screen.findAllByText("2 commits", undefined, { timeout: 2000 });

    expect(title()).toHaveValue("");
  });

  it("stays empty when there is nothing to merge", async () => {
    stubReads(() => Promise.resolve({ commits: [], truncated: false }));
    render(<CreatePrDialog />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("range_commits", expect.anything()));
    await act(async () => {});
    expect(title()).toHaveValue("");
  });
});
