// Stage-all eligibility derivation in the conflict workspace (GL-178): the
// "Stage all resolved" button must re-derive from the resolver's decisions and
// content cache — enabled exactly when at least one unstaged text file is fully
// decided — and staging must only touch the files that are actually ready.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ConflictWorkspace } from "./ConflictWorkspace";
import { useRepo } from "../../store/repo";
import type { OperationState } from "../../store/repo";

const MARKERS = "start\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> feat\nend\n";
const RESOLVED_OURS = "start\nour line\nend\n";

function operation(paths: string[]): OperationState {
  return {
    kind: "merge",
    canSkip: false,
    files: paths.map((path) => ({
      path,
      kind: "text" as const,
      deletedSide: "" as const,
      resolved: false,
    })),
  };
}

const flush = () => act(async () => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let resolveConflictFile: Mock<(file: string, content: string) => Promise<boolean>>;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === "conflict_file"
      ? Promise.resolve({ path: args?.file, content: MARKERS, binary: false })
      : Promise.resolve(null),
  );
  resolveConflictFile = vi.fn<(file: string, content: string) => Promise<boolean>>().mockResolvedValue(true);
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "x",
      detached: false,
    },
    operation: operation(["a.txt", "b.txt"]),
    resolveConflictFile,
    acceptConflictSide: vi.fn().mockResolvedValue(true),
    markConflictResolved: vi.fn().mockResolvedValue(true),
    reconflictFile: vi.fn().mockResolvedValue(true),
    continueOperation: vi.fn().mockResolvedValue(""),
    abortOperation: vi.fn().mockResolvedValue(""),
    skipOperation: vi.fn().mockResolvedValue(""),
  });
});

const stageAllButton = () =>
  screen.getByRole("button", { name: /Stage all resolved/i }) as HTMLButtonElement;

describe("ConflictWorkspace — stage-all eligibility (GL-178)", () => {
  it("enables Stage all once the open file's hunks are fully decided", async () => {
    render(<ConflictWorkspace />);
    await flush(); // a.txt (first unresolved) content loaded

    expect(stageAllButton()).toBeDisabled();

    // Decide the file's one hunk: take ours.
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    expect(stageAllButton()).toBeEnabled();
  });

  it("stages only the files whose decisions are complete", async () => {
    render(<ConflictWorkspace />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    fireEvent.click(stageAllButton());
    await flush();

    // b.txt was never opened (no cached content) and has no decisions — it must
    // not be staged, and certainly not with fabricated content.
    expect(resolveConflictFile).toHaveBeenCalledTimes(1);
    expect(resolveConflictFile).toHaveBeenCalledWith("a.txt", RESOLVED_OURS);
  });

  it("stages every ready file once each has been opened and decided", async () => {
    render(<ConflictWorkspace />);
    await flush();

    // Decide a.txt, then open b.txt (loads + caches its content) and decide it.
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    fireEvent.click(screen.getByText("b.txt"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    fireEvent.click(stageAllButton());
    await flush();

    expect(resolveConflictFile).toHaveBeenCalledTimes(2);
    expect(resolveConflictFile).toHaveBeenNthCalledWith(1, "a.txt", RESOLVED_OURS);
    expect(resolveConflictFile).toHaveBeenNthCalledWith(2, "b.txt", RESOLVED_OURS);
  });

  it("keeps decisions when a stage write fails, so Stage all can retry", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    resolveConflictFile.mockResolvedValueOnce(false);
    fireEvent.click(stageAllButton());
    await flush();

    // The failed write must not clear the user's decisions — the file is still
    // conflicted, still eligible, and a retry stages the same resolution.
    expect(resolveConflictFile).toHaveBeenCalledTimes(1);
    expect(stageAllButton()).toBeEnabled();
    fireEvent.click(stageAllButton());
    await flush();
    expect(resolveConflictFile).toHaveBeenNthCalledWith(2, "a.txt", RESOLVED_OURS);
  });

  it("stages serially — the second write starts only after the first settles", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    fireEvent.click(screen.getByText("b.txt"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    // Concurrent `git add`s contend for .git/index.lock — the loop must await
    // each write before starting the next.
    const first = deferred<boolean>();
    resolveConflictFile.mockImplementationOnce(() => first.promise);
    fireEvent.click(stageAllButton());
    await flush();
    expect(resolveConflictFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(true);
    });
    expect(resolveConflictFile).toHaveBeenCalledTimes(2);
  });
});
