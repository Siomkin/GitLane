import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Mock the IPC boundary + dialog plugin pulled in through the repo store.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { MissingRepoScreen } from "./MissingRepoScreen";
import { useRepo } from "../../store/repo";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

describe("MissingRepoScreen", () => {
  it("renders the moved/deleted copy with the path and all three recovery actions", () => {
    useRepo.setState({ missingRepo: { path: "/vol/gone", kind: "missing" } });
    render(<MissingRepoScreen />);

    expect(screen.getByText("This repository can't be found")).toBeInTheDocument();
    expect(screen.getByText(/may have been moved or deleted/)).toBeInTheDocument();
    expect(screen.getByText("/vol/gone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Locate/ })).toBeInTheDocument();
  });

  it("renders the not-a-repository copy for a folder that lost its .git", () => {
    useRepo.setState({ missingRepo: { path: "/still/here", kind: "notARepository" } });
    render(<MissingRepoScreen />);

    expect(screen.getByText("This folder is no longer a repository")).toBeInTheDocument();
    expect(
      screen.getByText("The folder still exists, but it no longer contains a git repository."),
    ).toBeInTheDocument();
  });

  it("wires Remove / Retry / Locate… to the store actions", () => {
    const loadRepo = vi.fn();
    const closeRepo = vi.fn();
    const locateMissingRepo = vi.fn();
    useRepo.setState({
      missingRepo: { path: "/vol/gone", kind: "missing" },
      loadRepo,
      closeRepo,
      locateMissingRepo,
    });
    render(<MissingRepoScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(closeRepo).toHaveBeenCalledWith("/vol/gone");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(loadRepo).toHaveBeenCalledWith("/vol/gone");
    fireEvent.click(screen.getByRole("button", { name: /Locate/ }));
    expect(locateMissingRepo).toHaveBeenCalled();
  });
});
