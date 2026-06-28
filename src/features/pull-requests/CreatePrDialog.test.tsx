// Finding: the create-PR submit button only disabled while `gh pr create` ran.
// Assert it now shows a creating spinner/label and stays disabled in flight.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePulls } from "../../store/pulls";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CreatePrDialog } from "./CreatePrDialog";

beforeEach(() => {
  usePulls.setState({ prPendingActions: [] });
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
  it("shows a creating spinner and disables submit while the PR is created", async () => {
    let resolveCreate!: (v: string) => void;
    const createPr = vi.fn(() => new Promise<string>((r) => (resolveCreate = r)));
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
});
