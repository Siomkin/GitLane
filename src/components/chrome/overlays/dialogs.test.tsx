import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { useUi, type ConfirmRequest, type PromptRequest } from "@/store/ui";
import { CreateBranchDialog, ConfirmDialog, PromptDialog } from "./dialogs";

// These dialogs are store-driven: each renders whatever its slice of `useUi`
// holds (createBranchOpen / confirm / prompt). The suite locks the shared modal
// contract (backdrop dismiss, Escape, Enter submit, autofocus) plus each
// dialog's own behavior before/after the per-contract split (GL-183).

// Captured before any test mutates store actions, so beforeEach can restore the
// real action after a test swaps in a spy (Zustand setState merges, so a mocked
// action would otherwise leak into later tests — and into later test files,
// since the store is a shared singleton with no global reset).
const realCreateBranchAt = useRepo.getState().createBranchAt;

beforeEach(() => {
  useRepo.setState({ summary: null, createBranchAt: realCreateBranchAt });
  useUi.setState({
    prompt: null,
    confirm: null,
    createBranchOpen: false,
    createBranchStart: null,
  });
});

/** The fixed backdrop is each dialog's root element. */
const backdrop = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe("CreateBranchDialog", () => {
  const openDialog = (start: string | null = "main") =>
    useUi.setState({ createBranchOpen: true, createBranchStart: start });

  it("renders nothing while closed", () => {
    const { container } = render(<CreateBranchDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("autofocuses the name input and shows the base branch", () => {
    openDialog("feature/base");
    render(<CreateBranchDialog />);
    expect(screen.getByPlaceholderText("feature/my-branch")).toHaveFocus();
    expect(screen.getByText("feature/base")).toBeInTheDocument();
  });

  it("exposes a labelled dialog and traps Tab focus inside it", () => {
    openDialog("main");
    render(<CreateBranchDialog />);
    expect(screen.getByRole("dialog", { name: "Create branch" })).toBeInTheDocument();
    // With an empty name the Create button is disabled, so Cancel is the last
    // focusable — Tab from it wraps back to the (autofocused) name input.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByPlaceholderText("feature/my-branch")).toHaveFocus();
  });

  it("submits the trimmed name on Enter and closes first", async () => {
    const createBranchAt = vi.fn().mockResolvedValue("Created");
    useRepo.setState({ createBranchAt });
    openDialog("main");
    render(<CreateBranchDialog />);

    const input = screen.getByPlaceholderText("feature/my-branch");
    fireEvent.change(input, { target: { value: "  feature/new  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(createBranchAt).toHaveBeenCalledWith("feature/new", "main");
    expect(useUi.getState().createBranchOpen).toBe(false);
    // Settle the fire-and-forget toast so it doesn't update state after teardown.
    await act(async () => {});
  });

  it("submits via the Create branch button", async () => {
    const createBranchAt = vi.fn().mockResolvedValue("Created");
    useRepo.setState({ createBranchAt });
    openDialog(null);
    render(<CreateBranchDialog />);

    fireEvent.change(screen.getByPlaceholderText("feature/my-branch"), {
      target: { value: "fix/thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    // With no explicit start point the branch is created from HEAD (undefined).
    expect(createBranchAt).toHaveBeenCalledWith("fix/thing", undefined);
    await act(async () => {});
  });

  it("blocks an invalid name: inline error, disabled button, Enter no-op", () => {
    const createBranchAt = vi.fn();
    useRepo.setState({ createBranchAt });
    openDialog();
    render(<CreateBranchDialog />);

    const input = screen.getByPlaceholderText("feature/my-branch");
    fireEvent.change(input, { target: { value: "bad..name" } });

    expect(screen.getByText("A branch name can't contain “..”.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(createBranchAt).not.toHaveBeenCalled();
    expect(useUi.getState().createBranchOpen).toBe(true);
  });

  it("blocks an empty name without showing a validation error", () => {
    const createBranchAt = vi.fn();
    useRepo.setState({ createBranchAt });
    openDialog();
    render(<CreateBranchDialog />);

    expect(screen.getByRole("button", { name: "Create branch" })).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText("feature/my-branch"), { key: "Enter" });
    expect(createBranchAt).not.toHaveBeenCalled();
  });

  it("closes on Escape from the input", () => {
    openDialog();
    render(<CreateBranchDialog />);
    fireEvent.keyDown(screen.getByPlaceholderText("feature/my-branch"), { key: "Escape" });
    expect(useUi.getState().createBranchOpen).toBe(false);
  });

  it("closes on backdrop click but not on a click inside the panel", () => {
    openDialog();
    const { container } = render(<CreateBranchDialog />);

    fireEvent.click(screen.getByText("Create branch", { selector: "div" }));
    expect(useUi.getState().createBranchOpen).toBe(true);

    fireEvent.click(backdrop(container));
    expect(useUi.getState().createBranchOpen).toBe(false);
  });

  it("closes on Cancel", () => {
    openDialog();
    render(<CreateBranchDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useUi.getState().createBranchOpen).toBe(false);
  });

  it("mounts a fresh name field when reopened", () => {
    openDialog();
    render(<CreateBranchDialog />);
    fireEvent.change(screen.getByPlaceholderText("feature/my-branch"), {
      target: { value: "stale/name" },
    });

    act(() => useUi.setState({ createBranchOpen: false }));
    act(() => openDialog());

    expect(screen.getByPlaceholderText("feature/my-branch")).toHaveValue("");
  });

  it("stacks at z-[60], below confirm/prompt", () => {
    openDialog();
    const { container } = render(<CreateBranchDialog />);
    expect(backdrop(container).className).toContain("z-[60]");
  });
});

describe("ConfirmDialog", () => {
  const openConfirm = (over: Partial<ConfirmRequest> = {}) => {
    const onConfirm = vi.fn();
    useUi.setState({ confirm: { title: "Delete branch?", onConfirm, ...over } });
    return onConfirm;
  };

  it("renders nothing without a pending confirm", () => {
    const { container } = render(<ConfirmDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("autofocuses the confirm button (Enter activates it natively, once)", () => {
    openConfirm();
    render(<ConfirmDialog />);
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("runs onConfirm then closes on confirm click", () => {
    const onConfirm = openConfirm({ confirmLabel: "Delete" });
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(useUi.getState().confirm).toBeNull();
  });

  it("closes without confirming on Escape (window-level)", () => {
    const onConfirm = openConfirm();
    render(<ConfirmDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(useUi.getState().confirm).toBeNull();
  });

  it("closes without confirming on backdrop click or Cancel", () => {
    const onConfirm = openConfirm();
    const { container } = render(<ConfirmDialog />);

    fireEvent.click(backdrop(container));
    expect(useUi.getState().confirm).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    // Reopening after render is a store update — flush it through act. The
    // reopened request carries its own spy; assert that one, not the first.
    let reopened!: ReturnType<typeof vi.fn>;
    act(() => {
      reopened = openConfirm();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useUi.getState().confirm).toBeNull();
    expect(reopened).not.toHaveBeenCalled();
  });

  it("renders message, details, and warnings blocks", () => {
    openConfirm({
      message: "This cannot be undone.",
      details: ["Deletes feature/x", "Removes its worktree"],
      warnings: ["Unpushed commits will be lost"],
    });
    render(<ConfirmDialog />);
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByText("Deletes feature/x")).toBeInTheDocument();
    expect(screen.getByText("Removes its worktree")).toBeInTheDocument();
    expect(screen.getByText("Unpushed commits will be lost")).toBeInTheDocument();
  });

  it("renders a secondary action that runs and closes like a confirm", () => {
    const onSecondary = vi.fn();
    const onConfirm = openConfirm({
      confirmLabel: "Check out here",
      secondary: { label: "Open that worktree", onClick: onSecondary },
    });
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Open that worktree" }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(useUi.getState().confirm).toBeNull();
  });

  it("omits the secondary button when the request has none", () => {
    openConfirm();
    render(<ConfirmDialog />);
    expect(screen.getAllByRole("button")).toHaveLength(2); // Cancel + Confirm
  });

  it("Escape fires neither the confirm nor the secondary action", () => {
    const onSecondary = vi.fn();
    const onConfirm = openConfirm({
      secondary: { label: "Open that worktree", onClick: onSecondary },
    });
    render(<ConfirmDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onSecondary).not.toHaveBeenCalled();
    expect(useUi.getState().confirm).toBeNull();
  });

  it("stacks at z-[80], above the create-branch dialog", () => {
    openConfirm();
    const { container } = render(<ConfirmDialog />);
    expect(backdrop(container).className).toContain("z-[80]");
  });

  it("styles the confirm button as destructive only when danger is set", () => {
    openConfirm({ danger: true });
    const { unmount } = render(<ConfirmDialog />);
    expect(screen.getByRole("button", { name: "Confirm" }).className).toContain("bg-rose-500");
    unmount();

    openConfirm();
    render(<ConfirmDialog />);
    expect(screen.getByRole("button", { name: "Confirm" }).className).not.toContain("bg-rose-500");
  });
});

describe("PromptDialog (text variant)", () => {
  const openPrompt = (over: Partial<PromptRequest> = {}) => {
    const onSubmit = vi.fn();
    useUi.setState({ prompt: { title: "Rename branch", onSubmit, ...over } });
    return onSubmit;
  };

  it("renders nothing without a pending prompt", () => {
    const { container } = render(<PromptDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("autofocuses the input, seeded with defaultValue", () => {
    openPrompt({ defaultValue: "feature/old" });
    render(<PromptDialog />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.value).toBe("feature/old");
  });

  it("selects the seeded text on focus so typing replaces it", () => {
    openPrompt({ defaultValue: "feature/old" });
    render(<PromptDialog />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("feature/old".length);
  });

  it("submits the trimmed value on Enter and closes", () => {
    const onSubmit = openPrompt();
    render(<PromptDialog />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  v1.2.0  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("v1.2.0");
    expect(useUi.getState().prompt).toBeNull();
  });

  it("ignores Enter on an empty value", () => {
    const onSubmit = openPrompt();
    render(<PromptDialog />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useUi.getState().prompt).not.toBeNull();
  });

  it("blocks a failing validator: inline error, disabled button, Enter no-op", () => {
    const onSubmit = openPrompt({
      validate: (v) => (v.includes(" ") ? "No spaces allowed." : null),
    });
    render(<PromptDialog />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "bad name" } });
    expect(screen.getByText("No spaces allowed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();

    // The disabled button covers clicks; Enter reaches fire() directly and must
    // be blocked there too.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useUi.getState().prompt).not.toBeNull();

    fireEvent.change(input, { target: { value: "good-name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("good-name");
  });

  it("closes without submitting on Escape, backdrop click, and Cancel", () => {
    // Each reopened prompt carries its own onSubmit spy — assert the one that
    // was live for each dismissal path, so no path can submit unnoticed.
    const escaped = openPrompt();
    render(<PromptDialog />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(useUi.getState().prompt).toBeNull();
    expect(escaped).not.toHaveBeenCalled();

    const backdropped = openPrompt();
    const { container } = render(<PromptDialog />);
    fireEvent.click(backdrop(container));
    expect(useUi.getState().prompt).toBeNull();
    expect(backdropped).not.toHaveBeenCalled();

    let cancelled!: ReturnType<typeof vi.fn>;
    act(() => {
      cancelled = openPrompt();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    expect(useUi.getState().prompt).toBeNull();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("stacks at z-[80], above the create-branch dialog", () => {
    openPrompt();
    const { container } = render(<PromptDialog />);
    expect(backdrop(container).className).toContain("z-[80]");
  });

  it("closes before running onSubmit so a follow-up prompt survives", () => {
    // The two-step annotated-tag flow: submitting the first prompt opens a
    // second one from inside onSubmit. If the dialog closed *after* running
    // onSubmit, the trailing closePrompt would null the follow-up.
    const secondSubmit = vi.fn();
    useUi.setState({
      prompt: {
        title: "Tag name",
        onSubmit: () =>
          useUi.getState().requestPrompt({ title: "Tag message", onSubmit: secondSubmit }),
      },
    });
    render(<PromptDialog />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "v1.0.0" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useUi.getState().prompt?.title).toBe("Tag message");
  });
});

describe("PromptDialog (multiline variant)", () => {
  const openMultiline = (over: Partial<PromptRequest> = {}) => {
    const onSubmit = vi.fn();
    useUi.setState({
      prompt: { title: "Squash message", multiline: true, onSubmit, ...over },
    });
    return onSubmit;
  };

  it("renders an autofocused textarea seeded with defaultValue", () => {
    openMultiline({ defaultValue: "line one\nline two" });
    render(<PromptDialog />);
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveFocus();
    expect(area.value).toBe("line one\nline two");
  });

  it("selects the seeded message on focus", () => {
    openMultiline({ defaultValue: "old message" });
    render(<PromptDialog />);
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.focus(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe("old message".length);
  });

  it("submits on ⌘Enter / Ctrl+Enter but not plain Enter (that's a newline)", () => {
    const onSubmit = openMultiline();
    render(<PromptDialog />);
    const area = screen.getByRole("textbox");
    fireEvent.change(area, { target: { value: "feat: squash" } });

    fireEvent.keyDown(area, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(area, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("feat: squash");

    act(() => {
      openMultiline({ defaultValue: "again" });
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(useUi.getState().prompt).toBeNull();
  });

  it("closes on Escape", () => {
    openMultiline();
    render(<PromptDialog />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(useUi.getState().prompt).toBeNull();
  });
});

// The searchable-picker variant: a prompt carrying `options` renders a
// filterable listbox instead of a bare text input.
const openPicker = (onSubmit: PromptRequest["onSubmit"], defaultValue?: string) =>
  useUi.setState({
    prompt: {
      title: "Compare feature with…",
      message: "Pick a branch to compare against (it becomes the base).",
      placeholder: "Search branches",
      defaultValue,
      confirmLabel: "Compare",
      options: [
        { value: "main", hint: "current" },
        { value: "develop" },
        { value: "origin/main", hint: "remote" },
      ],
      onSubmit,
    },
  });

describe("PromptDialog (picker variant)", () => {
  it("renders options as a listbox instead of a bare text input", () => {
    openPicker(vi.fn());
    render(<PromptDialog />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual([
      "maincurrent",
      "develop",
      "origin/mainremote",
    ]);
  });

  it("filters the list as the user types and submits the clicked branch", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dev" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("develop");

    fireEvent.click(options[0]);
    expect(onSubmit).toHaveBeenCalledWith("develop");
    // Submitting closes the prompt.
    expect(useUi.getState().prompt).toBeNull();
  });

  it("pre-highlights the option named by defaultValue and submits it on Enter", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit, "develop");
    render(<PromptDialog />);

    // The search box stays empty (it's a filter), but the default row is active.
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("develop");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("develop");
  });

  it("accepts a typed value that is not in the list (free-text fallback)", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "HEAD~2" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(onSubmit).toHaveBeenCalledWith("HEAD~2");
  });

  it("moves the highlight with ArrowDown/ArrowUp, clamped to the list ends", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);
    const box = screen.getByRole("combobox");

    fireEvent.keyDown(box, { key: "ArrowUp" }); // already at the top — stays
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("main");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" }); // past the end — clamps to last
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("origin/main");

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("origin/main");
  });

  it("resets the highlight when the query changes so Enter submits a visible row", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);
    const box = screen.getByRole("combobox");

    // Move the highlight to the last row, then narrow the list under it.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.change(box, { target: { value: "dev" } });

    // Enter must submit a row of the *filtered* list, never point past its end.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("develop");
  });

  it("re-highlights rows on hover and prevents focus steal on row mousedown", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);

    const rows = screen.getAllByRole("option");
    fireEvent.mouseEnter(rows[1]);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("develop");

    // onMouseDown preventDefault keeps the search box focused through the click.
    const notPrevented = fireEvent.mouseDown(rows[1]);
    expect(notPrevented).toBe(false);
  });

  it("closes on Escape without submitting", () => {
    const onSubmit = vi.fn();
    openPicker(onSubmit);
    render(<PromptDialog />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useUi.getState().prompt).toBeNull();
  });
});
