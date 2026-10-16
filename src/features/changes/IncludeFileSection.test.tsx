import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { FileChange } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { FileListView } from "@/lib/ui";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useAcpAgents } from "@/store/acpAgents";
import { useTerminalAgents } from "@/store/terminalAgents";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { summary } from "@/test/repoFixtures";
import { WorkingInspector } from "./WorkingInspector";

const file = (path: string): FileChange => ({ path, status: "M", add: 1, del: 0, binary: false });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({
    summary,
    // a.ts fully staged, b.ts partly, c.ts not at all.
    changes: {
      staged: [file("a.ts"), file("b.ts")],
      unstaged: [file("b.ts"), file("c.ts")],
      conflicted: [],
      advanced: emptyAdvancedState,
    },
    selectedFile: { path: "a.ts", source: "staged" },
  });
  useUi.setState({ menu: null, fileListView: FileListView.Path, changesView: "include" });
  useTerminalAgents.setState({ agents: [], loading: false, error: null, loadAgents: vi.fn(async () => {}) });
  useAcpAgents.setState({ agents: [], loading: false, error: null, loadAgents: vi.fn(async () => {}) });
});

const box = (path: string) => screen.getByRole("checkbox", { name: new RegExp(`(Include|Exclude) ${path}`) });

describe("WorkingInspector — Include view", () => {
  it("lists every path once with its three-state checkbox", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.getByText("Changes (3)")).toBeInTheDocument();
    expect(box("a.ts")).toHaveAttribute("aria-checked", "true");
    expect(box("b.ts")).toHaveAttribute("aria-checked", "mixed");
    expect(box("c.ts")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/^Unstaged/)).not.toBeInTheDocument();
  });

  it("stages an excluded or partly included file and unstages an included one", async () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.click(box("c.ts"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("stage_files", { path: "/repo", files: ["c.ts"] }),
    );
    fireEvent.click(box("b.ts"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("stage_files", { path: "/repo", files: ["b.ts"] }),
    );
    fireEvent.click(box("a.ts"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("unstage_files", { path: "/repo", files: ["a.ts"] }),
    );
  });

  it("switches to the Staging area sections without touching the index", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    invokeMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Staging area" }));
    expect(useUi.getState().changesView).toBe("staging");
    expect(screen.getByText("Unstaged (2)")).toBeInTheDocument();
    expect(screen.getByText("Staged (2)")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("stage_files", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("unstage_files", expect.anything());
  });
});
