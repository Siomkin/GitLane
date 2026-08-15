import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BranchKind,
  type BranchInfo,
  type CommitNode,
  type FileChange,
  type AcpAgent,
} from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { ComposerMode } from "@/lib/conventionalCommit";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession, openIntent } from "@/store/repoRequests";
import { useAcpAgents } from "@/store/acpAgents";
import { useUi, type PromptRequest } from "@/store/ui";
import { useCommitExecutionController } from "./useCommitExecutionController";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("./useCommitIdentity", () => ({
  useCommitIdentity: () => ({
    loading: false,
    applying: false,
    error: null,
    usable: true,
    effective: { name: "Ada", email: "ada@example.test" },
    identityText: "Ada · ada@example.test",
    sourceLabel: "This computer",
    selection: { kind: "default" },
    activeManual: null,
    manuals: [],
    defaultIdentity: { name: "Ada", email: "ada@example.test" },
    apply: vi.fn(async () => {}),
  }),
}));

const staged = (path: string): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
});

const agent: AcpAgent = { id: "codex", name: "codex", command: "codex-acp", model: "", config: {}, description: "", enabled: true, available: true };

const localBranch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "main",
  kind: BranchKind.Local,
  target: "head-oid",
  isHead: true,
  upstream: "origin/main",
  remote: null,
  sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
  ...over,
});

const headCommit: CommitNode = {
  id: "head-oid",
  shortId: "abc1234",
  summary: "previous summary",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "head-oid",
      detached: false,
    },
    forge: null,
    graph: null,
    branches: [localBranch()],
    changes: {
      staged: [staged("src/feature.ts")],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
    },
    commitSelected: vi.fn(async () => true),
    push: vi.fn(async () => {}),
    publishBranch: vi.fn(async () => ""),
  });
  useUi.setState({
    commitMsg: "fix: pending",
    commitComposerMode: ComposerMode.Conventional,
    commitDraftAgent: null,
    agentCommitDraft: null,
    requestPrompt: vi.fn(),
    openCreatePr: vi.fn(),
    showToast: vi.fn(),
    sendToTerminal: vi.fn(),
  });
  useAcpAgents.setState({
    agents: [agent],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
    loadMessages: vi.fn(async () => {}),
  });
});

describe("useCommitExecutionController", () => {
  it("snapshots the submitted message and amend flag while preserving an in-flight edit", async () => {
    const commitGate = deferred<boolean>();
    const commitSelected = vi.fn(() => commitGate.promise);
    useRepo.setState({
      commitSelected,
      graph: {
        commits: [headCommit],
        edges: [],
        laneCount: 1,
        head: headCommit.id,
        truncated: false,
      },
    });
    useUi.setState({ commitMsg: "" });
    const { result } = renderHook(() => useCommitExecutionController());

    act(() => result.current.toggleAmend());
    await waitFor(() => expect(result.current.canCommit).toBe(true));
    let operation = Promise.resolve(false);
    act(() => {
      operation = result.current.doCommit();
    });
    expect(commitSelected).toHaveBeenCalledWith("previous summary", true);
    act(() => useUi.getState().setCommitMsg("fix: edited while committing"));

    await act(async () => {
      commitGate.resolve(true);
      await operation;
    });

    expect(useUi.getState().commitMsg).toBe("fix: edited while committing");
    expect(result.current.amend).toBe(false);
  });

  it("clears the published commit draft but stops the push after a newer open intent", async () => {
    const commitGate = deferred<boolean>();
    const push = vi.fn(async () => {});
    useRepo.setState({
      commitSelected: vi.fn(() => commitGate.promise),
      push,
    });
    const { result } = renderHook(() => useCommitExecutionController());
    let operation = Promise.resolve();
    act(() => {
      operation = result.current.commitAndPush();
    });
    act(() => {
      openIntent.claim();
    });

    await act(async () => {
      commitGate.resolve(true);
      await operation;
    });

    expect(useUi.getState().commitMsg).toBe("");
    expect(push).not.toHaveBeenCalled();
  });

  it("stops the chained push when the checked-out branch changes during commit", async () => {
    const commitGate = deferred<boolean>();
    const push = vi.fn(async () => {});
    useRepo.setState({
      commitSelected: vi.fn(() => commitGate.promise),
      push,
    });
    const { result } = renderHook(() => useCommitExecutionController());
    let operation = Promise.resolve();
    act(() => {
      operation = result.current.commitAndPush();
      useRepo.setState({
        summary: {
          path: "/repo",
          workdir: "/repo",
          headBranch: "feature",
          headOid: "feature-head",
          detached: false,
        },
      });
    });

    await act(async () => {
      commitGate.resolve(true);
      await operation;
    });

    expect(push).not.toHaveBeenCalled();
  });

  it("rechecks prompt ownership and ignores submit after a same-path reopen", async () => {
    const requestPrompt = vi.fn();
    const publishBranch = vi.fn(async () => "");
    useRepo.setState({
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
      publishBranch,
    });
    useUi.setState({ requestPrompt });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitAndPush());
    expect(requestPrompt).toHaveBeenCalledOnce();
    const prompt = requestPrompt.mock.calls[0][0] as PromptRequest;

    act(() => {
      beginPublishedRepoSession();
      useRepo.setState({
        summary: {
          path: "/other",
          workdir: "/other",
          headBranch: "main",
          headOid: "other",
          detached: false,
        },
      });
      beginPublishedRepoSession();
      useRepo.setState({
        summary: {
          path: "/repo",
          workdir: "/repo",
          headBranch: "main",
          headOid: "replacement",
          detached: false,
        },
      });
      prompt.onSubmit("origin/main");
    });

    expect(publishBranch).not.toHaveBeenCalled();
  });

  it("ignores deferred publish after a newer open intent is claimed", async () => {
    const requestPrompt = vi.fn();
    const publishBranch = vi.fn(async () => "");
    useRepo.setState({
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
      publishBranch,
    });
    useUi.setState({ requestPrompt });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitAndPush());
    const prompt = requestPrompt.mock.calls[0][0] as PromptRequest;
    act(() => {
      openIntent.claim();
      prompt.onSubmit("origin/main");
    });

    expect(useRepo.getState().summary?.path).toBe("/repo");
    expect(publishBranch).not.toHaveBeenCalled();
  });

  it("opens a PR after deferred publish refreshes the captured branch to up-to-date", async () => {
    const requestPrompt = vi.fn();
    const openCreatePr = vi.fn();
    const publishBranch = vi.fn(async () => {
      useRepo.setState({ branches: [localBranch()] });
      return "Published main";
    });
    useRepo.setState({
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
      publishBranch,
    });
    useUi.setState({ requestPrompt, openCreatePr });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitPushOpenPr());
    expect(openCreatePr).not.toHaveBeenCalled();
    const prompt = requestPrompt.mock.calls[0][0] as PromptRequest;
    act(() => prompt.onSubmit("origin/main"));

    await waitFor(() => expect(publishBranch).toHaveBeenCalledWith("main", "origin/main"));
    await waitFor(() => expect(openCreatePr).toHaveBeenCalledOnce());
  });

  it("does not open a PR when checkout ownership changes during deferred publish", async () => {
    const publishGate = deferred<string>();
    const requestPrompt = vi.fn();
    const openCreatePr = vi.fn();
    const publishBranch = vi.fn(() => publishGate.promise);
    useRepo.setState({
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
      publishBranch,
    });
    useUi.setState({ requestPrompt, openCreatePr });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitPushOpenPr());
    const prompt = requestPrompt.mock.calls[0][0] as PromptRequest;
    act(() => prompt.onSubmit("origin/main"));
    await waitFor(() => expect(publishBranch).toHaveBeenCalledOnce());
    act(() => {
      useRepo.setState({
        summary: {
          path: "/repo",
          workdir: "/repo",
          headBranch: "feature",
          headOid: "feature-head",
          detached: false,
        },
        branches: [localBranch()],
      });
    });
    await act(async () => publishGate.resolve("Published main"));

    expect(openCreatePr).not.toHaveBeenCalled();
  });

  it("owns exactly one toast when deferred publish rejects", async () => {
    const requestPrompt = vi.fn();
    const showToast = vi.fn();
    useRepo.setState({
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
      publishBranch: vi.fn(async () => {
        throw new Error("publish exploded");
      }),
    });
    useUi.setState({ requestPrompt, showToast });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitAndPush());
    const prompt = requestPrompt.mock.calls[0][0] as PromptRequest;
    act(() => prompt.onSubmit("origin/main"));

    await waitFor(() => expect(showToast).toHaveBeenCalledOnce());
    expect(showToast).toHaveBeenCalledWith("Error: publish exploded", "error");
  });

  it("does not toast or open a PR merely because push resolved", async () => {
    const push = vi.fn(async () => {});
    const showToast = vi.fn();
    const openCreatePr = vi.fn();
    useRepo.setState({
      push,
      branches: [
        localBranch({
          sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 },
        }),
      ],
    });
    useUi.setState({ showToast, openCreatePr });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitPushOpenPr());
    await waitFor(() => expect(push).toHaveBeenCalledOnce());

    expect(showToast).not.toHaveBeenCalled();
    expect(openCreatePr).not.toHaveBeenCalled();
  });

  it("opens a PR only after push refreshes the captured branch to up-to-date", async () => {
    const openCreatePr = vi.fn();
    const push = vi.fn(async () => {
      useRepo.setState({ branches: [localBranch()] });
    });
    useRepo.setState({
      push,
      branches: [
        localBranch({
          sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 },
        }),
      ],
    });
    useUi.setState({ openCreatePr });
    const { result } = renderHook(() => useCommitExecutionController());

    await act(async () => result.current.commitPushOpenPr());

    await waitFor(() => expect(openCreatePr).toHaveBeenCalledOnce());
  });
});
