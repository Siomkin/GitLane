// StashContextMenu (GL-159): every operation must act on the stash's commit
// OID — a `stash@{n}` index captured at menu-open drifts if another worktree or
// terminal touches the stash stack before the click lands (GL-117).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { useUi, stashMenuOf, MenuKind } from "@/store/ui";
import { StashContextMenu } from "./StashContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Captured once so beforeEach restores the real actions after a test swaps in a
// spy (the store is a shared singleton — see menus.test.tsx).
const realApplyStash = useRepo.getState().applyStash;
const realBranchFromStash = useRepo.getState().branchFromStash;
const realDropStash = useRepo.getState().dropStash;

const OID = "cafe1234deadbeef";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => Promise.reject(new Error(`unexpected invoke: ${cmd}`)));
  useRepo.setState({
    applyStash: realApplyStash,
    branchFromStash: realBranchFromStash,
    dropStash: realDropStash,
  });
  useUi.setState({ menu: null, confirm: null, prompt: null, stackedReview: null });
  useNotifications.setState({ toasts: [] });
});

const openMenu = () =>
  useUi.setState({ menu: { kind: MenuKind.Stash, state: { x: 10, y: 10, oid: OID, message: "WIP on main: abc fix" } } });

const openGroup = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name }));

describe("StashContextMenu", () => {
  it("renders nothing until a stash menu is open", () => {
    const { container } = render(<StashContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("applies through the stash OID, never an index", () => {
    const applyStash = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ applyStash });
    openMenu();
    render(<StashContextMenu />);

    openGroup("Apply");
    // Both the accordion parent and its first child are named "Apply" — the
    // parent is the one carrying aria-expanded.
    const applyLeaf = screen
      .getAllByRole("menuitem", { name: "Apply" })
      .find((el) => !el.hasAttribute("aria-expanded"))!;
    fireEvent.click(applyLeaf);
    expect(applyStash).toHaveBeenCalledWith(OID, false);
  });

  it("apply-with-index keeps the staged/unstaged split, keyed by OID", () => {
    const applyStash = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ applyStash });
    openMenu();
    render(<StashContextMenu />);
    openGroup("Apply");
    fireEvent.click(screen.getByRole("menuitem", { name: "Apply with index" }));
    expect(applyStash).toHaveBeenCalledWith(OID, false, true);
  });

  it("pop applies-and-drops by OID", () => {
    const applyStash = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ applyStash });
    openMenu();
    render(<StashContextMenu />);
    openGroup("Apply");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pop (apply & drop)" }));
    expect(applyStash).toHaveBeenCalledWith(OID, true);
  });

  it("apply-to-new-branch prompts for the name and branches from the OID", () => {
    const branchFromStash = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ branchFromStash });
    openMenu();
    render(<StashContextMenu />);

    openGroup("Apply");
    fireEvent.click(screen.getByRole("menuitem", { name: "Apply to new branch…" }));
    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Apply stash to a new branch");
    prompt!.onSubmit("rescue/stash");
    expect(branchFromStash).toHaveBeenCalledWith(OID, "rescue/stash");
  });

  it("drop confirms with the stash message, then drops by OID", () => {
    const dropStash = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ dropStash });
    openMenu();
    render(<StashContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Drop" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.message).toContain("WIP on main: abc fix");
    expect(confirm?.danger).toBe(true);
    expect(dropStash).not.toHaveBeenCalled(); // nothing destructive before confirm
    confirm!.onConfirm();
    expect(dropStash).toHaveBeenCalledWith(OID);
  });

  it("view-changes opens the stacked review keyed by the OID", () => {
    openMenu();
    render(<StashContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "View changes" }));
    expect(useUi.getState().stackedReview).toMatchObject({ oid: OID, title: "Stash: WIP on main: abc fix" });
    expect(stashMenuOf(useUi.getState())).toBeNull();
  });
});
