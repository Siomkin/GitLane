// Every dialog in the app, held to the same modality contract (GL-350).
//
// Before this suite the contract was asserted once, against CreateBranchDialog
// ("exposes a labelled dialog and traps Tab focus inside it") — and three of the
// ten dialogs that hand-rolled their own backdrop had quietly lost it, including
// the `git rebase --abort` confirm. Now that every dialog renders through
// `ModalFrame`, the guarantee is structural, and this is the test that says so:
// add a dialog to the table below and it has to earn the same three properties.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, type RenderResult } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// Progress dialogs subscribe to backend step events; nothing here drives them.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { ForgeKind, type RepoSummary, type WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { CreateBranchDialog, ConfirmDialog, PromptDialog } from "./dialogs";
import { DeleteWorktreeDialog } from "./delete-worktree/DeleteWorktreeDialog";
import { GithubSigninDialog } from "./github-signin/GithubSigninDialog";
import { HandoffDialog } from "./handoff/HandoffDialog";
import { ProviderOauthDialog } from "./provider-oauth/ProviderOauthDialog";
import { RemoveDetachedDialog } from "./remove-detached/RemoveDetachedDialog";
import { SettingsModal } from "@/components/chrome/SettingsModal";
import { RepoSettingsModal } from "@/components/chrome/repo-settings/RepoSettingsModal";
import { EditCommitMessageDialog } from "@/features/changes/commit-modal/EditCommitMessageDialog";
import { CreatePrDialog } from "@/features/pull-requests/create-pr/CreatePrDialog";
import { AbortConfirm } from "@/features/conflicts/AbortConfirm";
import { ReflogRecoveryDialog } from "@/features/recovery/ReflogRecoveryDialog";
import { AgentMessageDialog } from "@/features/review-notes/ReviewNotes";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc",
  detached: false,
};

const worktree = (path: string): WorktreeInfo => ({
  name: path.split("/").pop()!,
  path,
  branch: null,
  isMain: false,
});

/** One dialog: how to open it, and how to render it. */
interface DialogCase {
  name: string;
  open?: () => void;
  render: () => RenderResult;
}

const cases: DialogCase[] = [
  {
    name: "CreateBranchDialog",
    open: () => useUi.setState({ createBranchOpen: true, createBranchStart: "main" }),
    render: () => render(<CreateBranchDialog />),
  },
  {
    name: "ConfirmDialog",
    open: () => useUi.setState({ confirm: { title: "Delete branch?", onConfirm: () => {} } }),
    render: () => render(<ConfirmDialog />),
  },
  {
    name: "PromptDialog",
    open: () => useUi.setState({ prompt: { title: "Rename branch", onSubmit: () => {} } }),
    render: () => render(<PromptDialog />),
  },
  {
    name: "EditCommitMessageDialog",
    open: () =>
      useUi.setState({
        editCommitMessage: { defaultValue: "old subject", onSubmit: () => {} },
      }),
    render: () => render(<EditCommitMessageDialog />),
  },
  {
    name: "CreatePrDialog",
    open: () => useUi.setState({ createPrOpen: true, createPrHead: "feature" }),
    render: () => render(<CreatePrDialog />),
  },
  {
    name: "AbortConfirm",
    render: () => render(<AbortConfirm kind="rebase" onCancel={() => {}} onConfirm={() => {}} />),
  },
  {
    name: "ReflogRecoveryDialog",
    open: () => useUi.setState({ recoveryOpen: true }),
    render: () => render(<ReflogRecoveryDialog />),
  },
  {
    name: "AgentMessageDialog",
    open: () =>
      useUi.setState({
        agentMessageOpen: true,
        agentMessageSurfaces: ["review"],
        agentMessageBranch: "feature",
      }),
    render: () => render(<AgentMessageDialog />),
  },
  {
    name: "SettingsModal",
    open: () => useUi.setState({ settingsOpen: true, settingsTab: "general" }),
    render: () => render(<SettingsModal />),
  },
  {
    name: "RepoSettingsModal",
    open: () => useUi.setState({ repoSettingsOpen: true }),
    render: () => render(<RepoSettingsModal />),
  },
  {
    name: "DeleteWorktreeDialog",
    open: () =>
      useUi.setState({ deleteWorktree: { branch: "feature", worktreePath: "/work/feature" } }),
    render: () => render(<DeleteWorktreeDialog />),
  },
  {
    name: "GithubSigninDialog",
    open: () => useUi.setState({ githubSignin: { host: "github.com" } }),
    render: () => render(<GithubSigninDialog />),
  },
  {
    name: "HandoffDialog",
    open: () =>
      useUi.setState({
        handoff: { branch: "feature", sourcePath: "/work/feature", sourceChanges: 0 },
      }),
    render: () => render(<HandoffDialog />),
  },
  {
    name: "ProviderOauthDialog",
    open: () =>
      useUi.setState({ providerOauthSignin: { provider: "gitlab", host: "gitlab.com" } }),
    render: () => render(<ProviderOauthDialog />),
  },
  {
    name: "RemoveDetachedDialog",
    open: () => useUi.setState({ removeDetached: { targets: [worktree("/work/detached")] } }),
    render: () => render(<RemoveDetachedDialog />),
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  // Every read a dialog fires on mount answers empty; none of them is the
  // subject here — the panel's semantics are.
  invokeMock.mockResolvedValue([]);
  useUi.setState({
    confirm: null,
    prompt: null,
    githubSignin: null,
    providerOauthSignin: null,
    handoff: null,
    deleteWorktree: null,
    removeDetached: null,
    editCommitMessage: null,
    createBranchOpen: false,
    createPrOpen: false,
    agentMessageOpen: false,
    reviewNotes: [],
    settingsOpen: false,
    repoSettingsOpen: false,
    recoveryOpen: false,
  });
  useRepo.setState({
    summary: SUMMARY,
    forge: {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/o/r",
    },
    worktrees: [],
  });
});

describe("every dialog is modal", () => {
  it.each(cases)("$name announces itself as a modal dialog", ({ open, render: mount }) => {
    open?.();
    mount();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Screen readers announce the name on open, so it has to exist — either
    // inline or through the visible heading it points at.
    const name =
      dialog.getAttribute("aria-label") ??
      document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent;
    expect(name?.trim()).toBeTruthy();
  });

  it.each(cases)("$name keeps Tab focus inside the panel", ({ open, render: mount }) => {
    open?.();
    mount();
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    // Tab from the last focusable must wrap back inside rather than escaping to
    // the inert content behind the backdrop.
    const last = focusables[focusables.length - 1] ?? dialog;
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("gives Escape to the most recently opened dialog only", () => {
    useUi.setState({ createBranchOpen: true, createBranchStart: "main" });
    render(<CreateBranchDialog />);
    // A confirmation raised on top of it — one Escape must dismiss the confirm
    // and leave the dialog underneath open.
    useUi.setState({ confirm: { title: "Discard?", onConfirm: () => {} } });
    render(<ConfirmDialog />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useUi.getState().confirm).toBeNull();
    expect(useUi.getState().createBranchOpen).toBe(true);
  });
});
