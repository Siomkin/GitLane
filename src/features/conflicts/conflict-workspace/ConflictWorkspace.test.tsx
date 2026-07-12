// Stage-all eligibility derivation in the conflict workspace (GL-178): the
// "Stage all resolved" button must re-derive from the resolver's decisions and
// content cache — enabled exactly when at least one unstaged text file is fully
// decided — and staging must only touch the files that are actually ready.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Make the editors' landing scroll observable: jsdom lacks scrollIntoView, and
// the landing defers through requestAnimationFrame.
const scrollSpy = vi.fn();
Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollSpy, writable: true });
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

import { ConflictWorkspace } from "./ConflictWorkspace";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import type { OperationState } from "@/store/repo";

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

describe("ConflictWorkspace — editor landing through the loading gate (GL-179)", () => {
  it("lands on the first undecided conflict once async content mounts the editor", async () => {
    scrollSpy.mockClear();
    render(<ConflictWorkspace />);
    // While conflict_file is in flight, the editor isn't mounted — no landing.
    expect(scrollSpy).not.toHaveBeenCalled();

    await flush(); // content loaded → editor mounts → landing scroll fires

    expect(scrollSpy).toHaveBeenCalled();
    const contexts = scrollSpy.mock.contexts;
    const target = contexts[contexts.length - 1] as Element;
    expect(target.getAttribute("data-region")).toBe("1"); // the first (only) hunk
  });
});

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

  it("disables Stage all when a refresh reclassifies the decided file as binary", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    expect(stageAllButton()).toBeEnabled();

    // The watcher re-read the worktree and a.txt is now a binary conflict.
    // Its decided text content still sits in the resolver cache — stale text
    // must never keep it eligible (it would git-add over the binary state).
    await act(async () => {
      useRepo.setState({
        operation: {
          kind: "merge",
          canSkip: false,
          files: [
            { path: "a.txt", kind: "binary", deletedSide: "", resolved: false },
            { path: "b.txt", kind: "text", deletedSide: "", resolved: false },
          ],
        },
      });
    });

    expect(stageAllButton()).toBeDisabled();
    expect(resolveConflictFile).not.toHaveBeenCalled();
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

  it("re-checks the disk copy before writing and skips a file that changed since it was decided", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    expect(stageAllButton()).toBeEnabled();

    // a.txt changed on disk after the decision, and no watcher refresh has
    // landed yet — the cached markers (and the decision made against them) are
    // stale. Staging must re-fetch and refuse to write the stale resolution.
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "conflict_file"
        ? Promise.resolve({
            path: args?.file,
            content: MARKERS.replace("our line", "our line edited"),
            binary: false,
          })
        : Promise.resolve(null),
    );
    fireEvent.click(stageAllButton());
    await flush();

    expect(resolveConflictFile).not.toHaveBeenCalled();
  });

  it("routes a marker-free ready file through mark_conflict_resolved (stage as-is)", async () => {
    // a.txt was fully resolved in an external editor: no markers left. Staging
    // it must stage the worktree copy as-is (like per-file "Mark resolved")
    // rather than rewriting the file from the cache — the two paths must not
    // diverge when cache and disk differ.
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "conflict_file"
        ? Promise.resolve({ path: args?.file, content: "plain resolved\n", binary: false })
        : Promise.resolve(null),
    );
    render(<ConflictWorkspace />);
    await flush();
    expect(stageAllButton()).toBeEnabled();

    fireEvent.click(stageAllButton());
    await flush();

    const markConflictResolved = useRepo.getState().markConflictResolved as Mock;
    expect(markConflictResolved).toHaveBeenCalledWith("a.txt");
    expect(resolveConflictFile).not.toHaveBeenCalled();
  });

  it("skips a file reclassified binary while an earlier stage write is still in flight", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();
    fireEvent.click(screen.getByText("b.txt"));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    const first = deferred<boolean>();
    resolveConflictFile.mockImplementationOnce(() => first.promise);
    fireEvent.click(stageAllButton());
    await flush();
    expect(resolveConflictFile).toHaveBeenCalledTimes(1);

    // While a.txt's write is in flight, the watcher reclassifies b.txt binary.
    // The loop's render snapshot still says "text" — it must re-read the live
    // entry and never write the stale text.
    await act(async () => {
      useRepo.setState({
        operation: {
          kind: "merge",
          canSkip: false,
          files: [
            { path: "a.txt", kind: "text", deletedSide: "", resolved: false },
            { path: "b.txt", kind: "binary", deletedSide: "", resolved: false },
          ],
        },
      });
    });
    await act(async () => {
      first.resolve(true);
    });

    expect(resolveConflictFile).toHaveBeenCalledTimes(1);
    expect(resolveConflictFile).not.toHaveBeenCalledWith("b.txt", expect.anything());
  });

  it("skips a file reclassified while its own pre-stage re-read is in flight", async () => {
    const showToast = vi.fn();
    useUi.setState({ showToast });
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    // The pre-stage disk re-read hangs; while it is in flight the watcher
    // reclassifies a.txt binary. The plan must be built from the post-await
    // store entry, not the one captured before the read started.
    const slowRead = deferred<{ path: unknown; content: string; binary: boolean }>();
    invokeMock.mockImplementationOnce(() => slowRead.promise);
    fireEvent.click(stageAllButton());
    await flush();
    await act(async () => {
      useRepo.setState({
        operation: {
          kind: "merge",
          canSkip: false,
          files: [
            { path: "a.txt", kind: "binary", deletedSide: "", resolved: false },
            { path: "b.txt", kind: "text", deletedSide: "", resolved: false },
          ],
        },
      });
    });
    await act(async () => {
      slowRead.resolve({ path: "a.txt", content: MARKERS, binary: false });
    });

    const markConflictResolved = useRepo.getState().markConflictResolved as Mock;
    expect(resolveConflictFile).not.toHaveBeenCalled();
    expect(markConflictResolved).not.toHaveBeenCalled();
    // The toast must name the actual reason — a reclassification, not a
    // hunk-staleness "changed on disk" message (GL-180 review).
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("no longer a text conflict"),
      "error",
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining("changed on disk"),
      expect.anything(),
    );
  });

  it("reports a failed write as a failure, not as 'changed on disk'", async () => {
    const showToast = vi.fn();
    useUi.setState({ showToast });
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    resolveConflictFile.mockResolvedValueOnce(false);
    fireEvent.click(stageAllButton());
    await flush();

    // The store action owns the failure toast; the workspace must not add a
    // misleading "changed on disk" one (the file didn't change — the write failed).
    expect(resolveConflictFile).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining("changed on disk"),
      expect.anything(),
    );
  });

  it("Mark resolved re-checks the disk copy: stages as-is when markers were resolved externally", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    // Between the decision and the click, the user resolved the file in an
    // external editor — the disk copy has no markers left. Mark resolved must
    // stage that worktree copy as-is, not overwrite it with the cached merge.
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "conflict_file"
        ? Promise.resolve({ path: args?.file, content: "externally resolved\n", binary: false })
        : Promise.resolve(null),
    );
    fireEvent.click(screen.getByRole("button", { name: /Mark resolved & stage/ }));
    await flush();

    const markConflictResolved = useRepo.getState().markConflictResolved as Mock;
    expect(markConflictResolved).toHaveBeenCalledWith("a.txt");
    expect(resolveConflictFile).not.toHaveBeenCalled();
  });

  it("Mark resolved refuses to write when the hunks changed on disk", async () => {
    render(<ConflictWorkspace />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Current \(ours\)/ }));
    await flush();

    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "conflict_file"
        ? Promise.resolve({
            path: args?.file,
            content: MARKERS.replace("our line", "our line edited"),
            binary: false,
          })
        : Promise.resolve(null),
    );
    fireEvent.click(screen.getByRole("button", { name: /Mark resolved & stage/ }));
    await flush();

    const markConflictResolved = useRepo.getState().markConflictResolved as Mock;
    expect(resolveConflictFile).not.toHaveBeenCalled();
    expect(markConflictResolved).not.toHaveBeenCalled();
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
