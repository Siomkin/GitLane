// The resolver hook's selection transition and facade identity (GL-178).
// The selection contract: default to the first unresolved conflict, keep a
// still-valid manual selection across operation refreshes (the watcher re-reads
// the worktree constantly — a refresh must never clobber the user's place), and
// correct it only when the selected file actually leaves the set. The facade
// must be referentially stable across unrelated rerenders so consumers can list
// `resolver` honestly in hook dependencies.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useConflictResolver } from "./useConflictResolver";
import type { OperationState } from "../../store/repo";

const MARKERS = "start\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> feat\nend\n";

function op(files: Array<{ path: string; resolved?: boolean }>): OperationState {
  return {
    kind: "merge",
    canSkip: false,
    files: files.map((f) => ({
      path: f.path,
      kind: "text" as const,
      deletedSide: "" as const,
      resolved: f.resolved ?? false,
    })),
  };
}

function renderResolver(operation: OperationState | null, repoPath: string | null = "/repo") {
  return renderHook(
    (props: { operation: OperationState | null; repoPath: string | null }) =>
      useConflictResolver(props.operation, props.repoPath),
    { initialProps: { operation, repoPath } },
  );
}

const flush = () => act(async () => {});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
    cmd === "conflict_file"
      ? Promise.resolve({ path: args?.file, content: MARKERS, binary: false })
      : Promise.resolve(null),
  );
});

describe("useConflictResolver — selection transition (GL-178)", () => {
  it("defaults the selection to the first unresolved file", async () => {
    const { result } = renderResolver(op([{ path: "a.txt", resolved: true }, { path: "b.txt" }]));
    await flush();
    expect(result.current.selected).toBe("b.txt");
  });

  it("keeps a valid manual selection across an operation refresh with new identities", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();

    // The watcher re-read the worktree: a fresh OperationState object with a
    // fresh files array but identical content. The user's place must survive.
    rerender({ operation: op([{ path: "a.txt" }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();
    expect(result.current.selected).toBe("b.txt");
  });

  it("moves the selection to the first unresolved file when the selected one leaves the set", async () => {
    const { result, rerender } = renderResolver(op([{ path: "a.txt" }, { path: "b.txt" }]));
    await flush();
    act(() => result.current.select("b.txt"));
    await flush();

    rerender({ operation: op([{ path: "a.txt" }]), repoPath: "/repo" });
    await flush();
    expect(result.current.selected).toBe("a.txt");
  });

  it("caches the selected text file's conflicted content and exposes it via contentFor", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    expect(result.current.content?.content).toBe(MARKERS);
    expect(result.current.contentFor("a.txt")?.content).toBe(MARKERS);
    expect(invokeMock.mock.calls.filter((c) => c[0] === "conflict_file")).toHaveLength(1);
  });
});

describe("useConflictResolver — path-key robustness (GL-178 review)", () => {
  it("keeps a selection whose filename contains a newline across a refresh", async () => {
    const weird = "we\nird.txt";
    const { result, rerender } = renderResolver(op([{ path: weird }, { path: "b.txt" }]));
    await flush();
    expect(result.current.selected).toBe(weird);

    rerender({ operation: op([{ path: weird }, { path: "b.txt" }]), repoPath: "/repo" });
    await flush();
    // A delimiter-based path key would misparse the newline and clobber this.
    expect(result.current.selected).toBe(weird);
  });

  it("resetFile drops only the exact file's cells, not a ::-prefixed sibling's", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }, { path: "a.txt::gen" }]));
    await flush();
    act(() => {
      result.current.decide("a.txt", 0, "ours");
      result.current.decide("a.txt::gen", 0, "theirs");
    });

    act(() => result.current.resetFile("a.txt"));

    expect(result.current.decisions["a.txt::0"]).toBeUndefined();
    // The sibling's decision must survive — never discard user choices.
    expect(result.current.decisions["a.txt::gen::0"]).toBe("theirs");
  });
});

describe("useConflictResolver — facade identity (GL-178)", () => {
  it("produces a new facade when the selected file's content loads", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    const before = result.current; // fetch still pending — content null

    await flush();

    expect(result.current).not.toBe(before);
    expect(result.current.content?.content).toBe(MARKERS);
  });

  it("returns a referentially stable facade across unrelated rerenders", async () => {
    // A resolved-only set fetches nothing, so nothing internal changes between
    // renders — the facade must not be rebuilt per render.
    const operation = op([{ path: "a.txt", resolved: true }]);
    const { result, rerender } = renderResolver(operation);
    await flush();

    const before = result.current;
    rerender({ operation, repoPath: "/repo" });
    await flush();
    expect(result.current).toBe(before);
  });

  it("produces a new facade when a decision lands (not over-memoized)", async () => {
    const { result } = renderResolver(op([{ path: "a.txt" }]));
    await flush();

    const before = result.current;
    act(() => result.current.decide("a.txt", 0, "ours"));
    expect(result.current).not.toBe(before);
    expect(result.current.decisions["a.txt::0"]).toBe("ours");
  });
});
