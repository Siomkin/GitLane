import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useAccounts } from "@/store/accounts";
import { RemotesPanel } from "./RemotesPanel";

const ORIGIN = {
  name: "origin",
  fetchUrl: "https://github.com/me/repo.git",
  pushUrl: "https://github.com/me/repo.git",
  isDefault: true,
};

const NEW_URL = "https://github.com/me/upstream.git";

// invoke router: list_remotes always resolves; add_remote is overridable per test.
const routeInvoke = (addResult: () => Promise<unknown>) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "list_remotes") return Promise.resolve([ORIGIN]);
    if (cmd === "add_remote") return addResult();
    return Promise.resolve([]);
  });

const openAddForm = async () => {
  // The dashed "Add remote" trigger only renders once the list has loaded.
  fireEvent.click(await screen.findByRole("button", { name: "Add remote" }));
  fireEvent.change(screen.getByLabelText("Remote name"), { target: { value: "upstream" } });
  fireEvent.change(screen.getByLabelText("Remote URL"), { target: { value: NEW_URL } });
};

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo/GitLane", headBranch: "main", headOid: "abc1234", detached: false },
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  useAccounts.setState({ repoAccountRef: null });
  useUi.setState({ toast: null, confirm: null });
});

describe("RemotesPanel add UX", () => {
  it("keeps the form open with the user's input when the add fails", async () => {
    routeInvoke(() => Promise.reject("remote upstream already exists"));
    render(<RemotesPanel />);
    await openAddForm();

    fireEvent.click(screen.getByRole("button", { name: "Add remote" })); // submit
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("add_remote", expect.anything()));

    // Form is still open and the URL the user typed is preserved.
    expect(screen.getByLabelText("Remote URL")).toHaveValue(NEW_URL);
    expect(useUi.getState().toast?.message).toMatch(/Couldn't add upstream/);
  });

  it("collapses the form after a successful add", async () => {
    routeInvoke(() => Promise.resolve(""));
    render(<RemotesPanel />);
    await openAddForm();

    fireEvent.click(screen.getByRole("button", { name: "Add remote" })); // submit
    await waitFor(() => expect(screen.queryByLabelText("Remote URL")).toBeNull());
    // And the repo refresh fires so the toolbar provider updates immediately.
    expect(useRepo.getState().refresh).toHaveBeenCalled();
  });

  it("blocks submit for an invalid remote name", async () => {
    routeInvoke(() => Promise.resolve(""));
    render(<RemotesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add remote" }));
    fireEvent.change(screen.getByLabelText("Remote name"), { target: { value: "bad name" } });
    fireEvent.change(screen.getByLabelText("Remote URL"), { target: { value: NEW_URL } });

    expect(screen.getByRole("button", { name: "Add remote" })).toBeDisabled();
    expect(screen.getByText(/Remote name: letters or digits/)).toBeInTheDocument();
  });
});
