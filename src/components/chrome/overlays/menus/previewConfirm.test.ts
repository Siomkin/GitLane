import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { previewConfirm } from "./previewConfirm";

const impact = { summary: "Delete branch", details: [], warnings: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "head",
      detached: false,
    },
  });
  useUi.setState({ confirm: null });
});

describe("previewConfirm published-session ownership", () => {
  it("does not open a slow preview after the same repo path was reopened", async () => {
    const preview = deferred<typeof impact>();
    const requestConfirm = vi.fn();
    const pending = previewConfirm({
      requestConfirm,
      title: "Delete",
      message: "Delete it?",
      confirmLabel: "Delete",
      preview: () => preview.promise,
      onConfirm: vi.fn(),
    });

    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "other", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "new", detached: false },
    });
    preview.resolve(impact);
    await pending;

    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("does not run an opened confirm after the same repo path was reopened", async () => {
    const requestConfirm = vi.fn();
    const onConfirm = vi.fn();
    await previewConfirm({
      requestConfirm,
      title: "Delete",
      message: "Delete it?",
      confirmLabel: "Delete",
      preview: async () => impact,
      onConfirm,
    });
    const confirm = requestConfirm.mock.calls[0]?.[0];

    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "other", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "new", detached: false },
    });
    confirm?.onConfirm();

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
