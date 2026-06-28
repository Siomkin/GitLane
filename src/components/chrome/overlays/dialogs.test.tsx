import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUi, type PromptRequest } from "../../../store/ui";
import { PromptDialog } from "./dialogs";

// PromptDialog is store-driven: it renders whatever `ui.prompt` holds. These
// tests exercise the searchable-picker variant (a prompt carrying `options`).
beforeEach(() => {
  useUi.setState({ prompt: null });
});

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
});
