// The real controls in front of a dirty editor: each one must raise the discard
// dialog instead of leaving, and leave without asking when the editor is clean.
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyIpcInvoke } from "@/test/ipcFixtures";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { WorkingInspector } from "@/features/changes/WorkingInspector";
import { useOnboarding } from "@/features/onboarding/flows/useOnboarding";
import { isMac } from "@/lib/platform";
import { useRepo } from "@/store/repo";
import type { FileViewState, RepoState } from "@/store/repoTypes";
import { useUi } from "@/store/ui";
import { useUpdates } from "@/store/updates";
import { summary } from "@/test/repoFixtures";
import { ConfirmDialog } from "./overlays/dialogs/ConfirmDialog";
import { RepoTabStrip } from "./repo-tabs/RepoTabStrip";
import { TitleBar } from "./TitleBar";

const updater = vi.hoisted(() => ({ relaunchApp: vi.fn() }));
vi.mock("@/lib/updater", async (load) => ({
  ...(await load<typeof import("@/lib/updater")>()),
  relaunchApp: updater.relaunchApp,
}));

const file = (draft: string) =>
  ({
    path: "a.ts",
    content: { text: "saved" },
    loading: false,
    error: null,
    edit: { draft, baseSize: 5, baseExpectedState: "s", saving: false },
  }) as unknown as FileViewState;
const DIRTY = file("typed");
const CLEAN = file("saved");

const real = useRepo.getState();
const loadRepo = vi.fn(async () => {});
const closeRepo = vi.fn(async () => {});
const asked = () => useUi.getState().confirm !== null;
const pressDigit2 = () =>
  fireEvent.keyDown(document, { code: "Digit2", ...(isMac ? { metaKey: true } : { ctrlKey: true }) });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  loadRepo.mockClear();
  closeRepo.mockClear();
  updater.relaunchApp.mockReset();
  updater.relaunchApp.mockResolvedValue(undefined);
  useRepo.setState(real, true);
  useRepo.setState({
    summary,
    openPaths: [summary.path, "/other"],
    recents: [],
    tabInfoByPath: {},
    pendingOpen: null,
    missingRepo: null,
    fileView: null,
    loadRepo,
    closeRepo,
  });
  useUi.setState({ confirm: null, histSearchOpen: false, stackedReview: null, repoGroups: [] });
});

describe.each<[string, () => void, () => void]>([
  [
    "⌘2 tab shortcut",
    () => {
      render(<TitleBar />);
      pressDigit2();
    },
    () => expect(loadRepo).toHaveBeenCalledWith("/other"),
  ],
  [
    "clicking another tab",
    () => {
      render(<RepoTabStrip />);
      fireEvent.click(screen.getByText("other"));
    },
    () => expect(loadRepo).toHaveBeenCalledWith("/other"),
  ],
  [
    "the title-bar Search",
    () => {
      render(<TitleBar />);
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
    },
    () => expect(useUi.getState().histSearchOpen).toBe(true),
  ],
  [
    "restarting to install an update",
    () => void useUpdates.getState().restart(),
    () => expect(updater.relaunchApp).toHaveBeenCalledTimes(1),
  ],
])("%s", (_name, act, left) => {
  it("asks when the draft is dirty and leaves nothing changed", () => {
    useRepo.setState({ fileView: DIRTY });
    act();
    expect(asked()).toBe(true);
    expect(useRepo.getState().fileView).toBe(DIRTY);
    expect(loadRepo).not.toHaveBeenCalled();
    expect(updater.relaunchApp).not.toHaveBeenCalled();
    expect(useUi.getState().histSearchOpen).toBe(false);
  });

  it("leaves after the discard is confirmed", () => {
    useRepo.setState({ fileView: DIRTY });
    act();
    useUi.getState().confirm?.onConfirm();
    left();
  });

  it("does not ask when the editor is clean", () => {
    useRepo.setState({ fileView: CLEAN });
    act();
    expect(asked()).toBe(false);
    left();
  });
});

describe("ConfirmDialog", () => {
  const second = { title: "Second", onConfirm: () => {} };

  it("keeps a confirm raised by the confirm action", () => {
    useUi.getState().requestConfirm({
      title: "First",
      confirmLabel: "Go",
      onConfirm: () => useUi.getState().requestConfirm(second),
    });
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(useUi.getState().confirm?.title).toBe("Second");
  });

  it("keeps a confirm raised by the secondary action", () => {
    useUi.getState().requestConfirm({
      title: "First",
      onConfirm: () => {},
      secondary: { label: "Other", onClick: () => useUi.getState().requestConfirm(second) },
    });
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(useUi.getState().confirm?.title).toBe("Second");
  });
});

describe("tab close buttons", () => {
  const closeButtons = () => screen.getAllByRole("button", { name: /close/i });

  it("ask for the active tab", () => {
    useRepo.setState({ fileView: DIRTY });
    render(<RepoTabStrip />);
    fireEvent.click(closeButtons()[0]);
    expect(asked()).toBe(true);
    expect(closeRepo).not.toHaveBeenCalled();
  });

  it("do not ask for a background tab", () => {
    useRepo.setState({ fileView: DIRTY });
    render(<RepoTabStrip />);
    fireEvent.click(closeButtons()[1]);
    expect(asked()).toBe(false);
    expect(closeRepo).toHaveBeenCalledWith("/other");
    expect(useRepo.getState().fileView).toBe(DIRTY);
  });
});

describe("WorkingInspector", () => {
  const changes = {
    staged: [],
    unstaged: [{ path: "b.ts", status: "M" }],
    conflicted: [],
  } as unknown as RepoState["changes"];

  it("asks before a file row opens its diff, and stays put if declined", () => {
    const onOpenChanges = vi.fn();
    const selectFile = vi.fn(async () => {});
    useRepo.setState({ changes, selectFile, fileView: DIRTY });
    render(<WorkingInspector onOpenChanges={onOpenChanges} />);
    selectFile.mockClear(); // The mount effect reconciles the selection.
    fireEvent.click(screen.getByText("b.ts"));
    expect(asked()).toBe(true);
    expect(selectFile).not.toHaveBeenCalled();
    expect(onOpenChanges).not.toHaveBeenCalled();
  });
});

describe("opening another repository from the onboarding overlay", () => {
  it("asks first, and dismisses only after the open", async () => {
    const onDone = vi.fn();
    useRepo.setState({ fileView: DIRTY });
    const { result } = renderHook(() => useOnboarding(onDone));
    result.current.openRecent({ path: "/other", missing: false } as never);
    expect(asked()).toBe(true);
    expect(loadRepo).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
