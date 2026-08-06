// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import type { CommitNode, StashEntry } from "@/lib/api";
import type { HistoryRow } from "./historyRows";
import { historyKeyDownHandler } from "./historyKeyboardNav";

const commit = (id: string) => ({ id, summary: id }) as CommitNode;
const stash = (oid: string) => ({ oid, message: oid }) as StashEntry;

// wip → c1 → (stash context, not selectable) → c2 → stash → load-more
const ROWS: HistoryRow[] = [
  { kind: "wip", key: "wip" },
  { kind: "commit", key: "c1", commit: commit("c1") },
  {
    kind: "stash-context",
    key: "ctx",
    commit: { id: "ctx" } as never,
    rowIndex: 0,
    markerLane: 0,
  },
  { kind: "commit", key: "c2", commit: commit("c2") },
  { kind: "stash", key: "s1", stash: stash("s1"), rowIndex: 0, markerLane: 0 },
  { kind: "load-more", key: "load-more" },
];

const scrollToIndex = vi.fn();
const virtualizer = { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>;
const scrollRef = { current: { focus: vi.fn() } as unknown as HTMLDivElement };

const selectCommitMulti = vi.fn();
const selectWip = vi.fn();
const openChangesView = vi.fn();

const key = (init: Partial<KeyboardEvent<HTMLDivElement>>) =>
  ({ preventDefault: vi.fn(), metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent<HTMLDivElement>;

// A plain factory: buildable outside a render, so this stays cheap instead of
// mounting the whole workspace.
const navigate = () => historyKeyDownHandler(ROWS, virtualizer, scrollRef);

beforeEach(() => {
  vi.clearAllMocks();
  useRepo.setState({ wipSelected: false, selectedCommit: null, selectCommitMulti, selectWip });
  useUi.setState({ openChangesView });
});

describe("history keyboard navigation", () => {
  it("moves one row at a time and scrolls it into view", () => {
    useRepo.setState({ selectedCommit: "c1" });
    const event = key({ key: "ArrowDown" });

    navigate()(event);

    // c1 → c2: the stash-context row in between is skipped, not landed on.
    expect(selectCommitMulti).toHaveBeenCalledWith("c2", { shift: false });
    expect(scrollToIndex).toHaveBeenCalledWith(3, { align: "auto" });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("steps onto the WIP row and back", () => {
    useRepo.setState({ selectedCommit: "c1" });

    navigate()(key({ key: "ArrowUp" }));

    expect(selectWip).toHaveBeenCalled();
  });

  it("selects stash rows too", () => {
    useRepo.setState({ selectedCommit: "c2" });

    navigate()(key({ key: "ArrowDown" }));

    expect(selectCommitMulti).toHaveBeenCalledWith("s1", { shift: false });
  });

  it("extends the range with Shift", () => {
    useRepo.setState({ selectedCommit: "c1" });

    navigate()(key({ key: "ArrowDown", shiftKey: true }));

    expect(selectCommitMulti).toHaveBeenCalledWith("c2", { shift: true });
  });

  it("stops at the ends instead of wrapping", () => {
    useRepo.setState({ wipSelected: true });

    navigate()(key({ key: "ArrowUp" }));

    expect(selectWip).not.toHaveBeenCalled();
    expect(selectCommitMulti).not.toHaveBeenCalled();
  });

  it("enters the list from the near end when nothing is selected", () => {
    navigate()(key({ key: "ArrowDown" }));

    expect(selectWip).toHaveBeenCalled();
  });

  it("opens the working changes with Enter on the WIP row", () => {
    useRepo.setState({ wipSelected: true });
    const event = key({ key: "Enter" });

    navigate()(event);

    expect(openChangesView).toHaveBeenCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("leaves ⌘/Ctrl chords to the global Review shortcut", () => {
    useRepo.setState({ selectedCommit: "c1" });
    const event = key({ key: "ArrowDown", metaKey: true });

    navigate()(event);

    expect(selectCommitMulti).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
