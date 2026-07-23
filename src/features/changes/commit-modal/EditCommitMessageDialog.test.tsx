import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerMode } from "@/lib/conventionalCommit";
import { useUi } from "@/store/ui";
import { EditCommitMessageDialog } from "./EditCommitMessageDialog";

const openEditor = (
  onSubmit = vi.fn(),
  defaultValue = "fix(ui): keep the message\n\nExplain why.",
) => {
  useUi.getState().requestEditCommitMessage({
    message: "This commit has not been pushed.",
    defaultValue,
    onSubmit,
  });
  return onSubmit;
};

beforeEach(() => {
  useUi.setState({
    editCommitMessage: null,
    commitComposerMode: ComposerMode.Message,
  });
});

describe("EditCommitMessageDialog", () => {
  it("renders nothing without a pending edit request", () => {
    const { container } = render(<EditCommitMessageDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reuses the Message / Conventional editor without agent controls", () => {
    openEditor();
    render(<EditCommitMessageDialog />);

    const message = screen.getByRole("textbox", { name: "Commit message" });
    expect(message).toHaveValue("fix(ui): keep the message\n\nExplain why.");
    expect(message).toHaveFocus();
    expect(screen.getByRole("button", { name: "Message" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Conventional" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Improve" })).not.toBeInTheDocument();
  });

  it("round-trips edits across Conventional and Message modes", () => {
    openEditor();
    render(<EditCommitMessageDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Conventional" }));
    expect(screen.getByRole("combobox", { name: "Commit type" })).toHaveValue("fix");
    expect(screen.getByRole("textbox", { name: "Commit scope" })).toHaveValue("ui");
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toHaveValue(
      "keep the message",
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
      target: { value: "improve the editor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Message" }));

    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
      "fix(ui): improve the editor\n\nExplain why.",
    );
  });

  it("submits a trimmed message on Ctrl+Enter and closes first", () => {
    const onSubmit = openEditor(vi.fn(), "old message");
    render(<EditCommitMessageDialog />);

    const message = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(message, { target: { value: "  fix: better message  " } });
    fireEvent.keyDown(message, { key: "Enter", ctrlKey: true });

    expect(useUi.getState().editCommitMessage).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith("fix: better message");
  });

  it("disables submit for an empty message and cancels without submitting", () => {
    const onSubmit = openEditor();
    render(<EditCommitMessageDialog />);

    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "Update message" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useUi.getState().editCommitMessage).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
