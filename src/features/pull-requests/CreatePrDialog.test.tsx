// Finding: the create-PR submit button only disabled while `gh pr create` ran.
// Assert it now shows a creating spinner/label and stays disabled in flight.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PR_PENDING_ACTION, usePulls } from "../../store/pulls";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CreatePrDialog } from "./CreatePrDialog";

const realCreatePr = usePulls.getState().createPr;

beforeEach(() => {
  usePulls.setState({ prPendingActions: [], createPr: realCreatePr });
  useRepo.setState({
    summary: { headBranch: "feat/x" } as never,
    branches: [
      { kind: "local", name: "feat/x" },
      { kind: "local", name: "develop" },
    ] as never,
  });
  useUi.setState({ createPrOpen: true });
});

describe("CreatePrDialog submit loader", () => {
  it("mounts a fresh form when reopened", async () => {
    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "Stale title");
    await userEvent.type(screen.getByPlaceholderText("Describe your changes… (Markdown supported)"), "Stale body");

    act(() => useUi.setState({ createPrOpen: false }));
    act(() => useUi.setState({ createPrOpen: true }));

    expect(screen.getByPlaceholderText("Title")).toHaveValue("");
    expect(screen.getByPlaceholderText("Describe your changes… (Markdown supported)")).toHaveValue("");
  });

  it("shows a creating spinner and disables submit while the PR is created", async () => {
    let resolveCreate!: (v: string) => void;
    const createPr = vi.fn(() => {
      usePulls.setState({
        prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Create, prNum: null }],
      });
      return new Promise<string>((r) => (resolveCreate = r)).finally(() => {
        usePulls.setState({ prPendingActions: [] });
      });
    });
    usePulls.setState({ createPr });

    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "My PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(createPr).toHaveBeenCalledWith("develop", "feat/x", "My PR", "", false);
    const creating = await screen.findByRole("button", { name: "Creating…" });
    expect(creating).toHaveAttribute("aria-busy", "true");
    expect(creating).toBeDisabled();

    resolveCreate("https://github.com/x/y/pull/99");
    await waitFor(() => expect(screen.queryByText("Creating…")).not.toBeInTheDocument());
  });

  it("keeps the reopened dialog disabled while a create remains in flight", async () => {
    let resolveCreate!: (v: string) => void;
    const createPr = vi.fn(() => {
      usePulls.setState({
        prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Create, prNum: null }],
      });
      return new Promise<string>((r) => (resolveCreate = r)).finally(() => {
        usePulls.setState({ prPendingActions: [] });
      });
    });
    usePulls.setState({ createPr });
    render(<CreatePrDialog />);
    await userEvent.type(screen.getByPlaceholderText("Title"), "My PR");
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => useUi.setState({ createPrOpen: true }));

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    resolveCreate("https://github.com/x/y/pull/99");
    await waitFor(() => expect(screen.queryByText("Creating…")).not.toBeInTheDocument());
  });
});
