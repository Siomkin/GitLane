import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { RepoFileWorkspace } from "./RepoFileWorkspace";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const SUMMARY = { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false };

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ summary: null, fileView: null });
  useUi.setState({ confirm: null });
});

describe("RepoFileWorkspace — read-only", () => {
  it("renders the file's numbered lines and closes back to the previous view", () => {
    useRepo.setState({
      fileView: {
        path: "src/App.tsx",
        content: { text: "one\ntwo", size: 7, truncated: false, binary: false },
        loading: false,
        error: null,
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("2 lines · 7 B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close file" }));
    expect(useRepo.getState().fileView).toBeNull();
  });

  it("shows the binary notice and offers no Edit", () => {
    useRepo.setState({
      fileView: { path: "logo.png", content: { size: 2048, truncated: false, binary: true }, loading: false, error: null },
    });
    render(<RepoFileWorkspace />);
    expect(screen.getByText("Binary file — no text preview.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("flags a truncated read as read-only with no Edit", () => {
    useRepo.setState({
      fileView: {
        path: "big.txt",
        content: { text: "x".repeat(10), size: 4096, truncated: true, binary: false },
        loading: false,
        error: null,
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.getByText(/Large file — showing the first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("offers a retry on a read failure", () => {
    useRepo.setState({
      summary: SUMMARY,
      fileView: { path: "gone.ts", content: null, loading: false, error: "read failed" },
    });
    invokeMock.mockResolvedValue({ text: "back", size: 4, truncated: false, binary: false });
    render(<RepoFileWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(invokeMock).toHaveBeenCalledWith("repo_file_text", { path: "/r", file: "gone.ts", maxBytes: null });
  });
});

describe("RepoFileWorkspace — preview switcher", () => {
  it("shows Source/Preview only for markdown and renders the rendered form", () => {
    useRepo.setState({
      fileView: {
        path: "README.md",
        content: { text: "# Title\n\nbody", size: 14, truncated: false, binary: false },
        loading: false,
        error: null,
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    // The Markdown renderer turns "# Title" into a heading.
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  });

  it("has no preview switcher for a plain source file", () => {
    useRepo.setState({
      fileView: {
        path: "src/App.tsx",
        content: { text: "code", size: 4, truncated: false, binary: false },
        loading: false,
        error: null,
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });
});

describe("RepoFileWorkspace — editing", () => {
  const openEditable = () =>
    useRepo.setState({
      summary: SUMMARY,
      fileView: {
        path: "src/a.ts",
        content: { text: "const x = 1\n", size: 12, truncated: false, binary: false },
        loading: false,
        error: null,
      },
    });

  it("edits and saves, passing the on-disk size guard and clearing dirty", async () => {
    openEditable();
    invokeMock.mockResolvedValue(16); // new byte size
    render(<RepoFileWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "File contents" });
    // Save is disabled until the buffer diverges.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "const x = 100\n" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("write_repo_file", {
        path: "/r",
        file: "src/a.ts",
        content: "const x = 100\n",
        expectedSize: 12,
      }),
    );
    // After the save the draft is the clean baseline again → dirty clears.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
    expect(useRepo.getState().fileView?.content?.text).toBe("const x = 100\n");
    expect(useRepo.getState().fileView?.content?.size).toBe(16);
  });

  it("confirms before closing with unsaved changes", () => {
    openEditable();
    render(<RepoFileWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "dirty" } });

    fireEvent.click(screen.getByRole("button", { name: "Close file" }));
    // A confirm is requested rather than closing immediately.
    expect(useUi.getState().confirm?.title).toBe("Discard unsaved changes?");
    expect(useRepo.getState().fileView).not.toBeNull();
  });

  it("the close/Done discard confirm re-checks saving (⌘S after the dialog opens blocks it)", () => {
    openEditable();
    render(<RepoFileWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "File contents" }), { target: { value: "dirty" } });
    fireEvent.click(screen.getByRole("button", { name: "Close file" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Discard unsaved changes?");
    // A save starts (via ⌘S) after the dialog is open.
    useRepo.setState((s) => ({ fileView: { ...s.fileView!, edit: { ...s.fileView!.edit!, saving: true } } }));
    confirm!.onConfirm();
    // The uncancellable write is committing, so the file stays open.
    expect(useRepo.getState().fileView).not.toBeNull();
  });

  it("freezes the textarea while a save is in flight", async () => {
    openEditable();
    let resolveWrite!: (n: number) => void;
    // Command-aware: the baseline read fired by entering edit must not consume
    // the write's one-shot mock.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "repo_file_head_text") return Promise.resolve(null);
      if (cmd === "write_repo_file") return new Promise((r) => (resolveWrite = r));
      return Promise.resolve(undefined);
    });
    render(<RepoFileWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "File contents" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "const x = 2\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // While saving the buffer is read-only so keystrokes can't outrace the write,
    // and Done/Close are frozen so a discard can't claim the edits were dropped
    // while the write actually commits.
    await waitFor(() => expect(textarea).toHaveAttribute("readonly"));
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close file" })).toBeDisabled();
    resolveWrite(11);
    await waitFor(() => expect(textarea).not.toHaveAttribute("readonly"));
  });

  it("shows the overview ruler when the buffer differs from the committed baseline", () => {
    useRepo.setState({
      summary: SUMMARY,
      fileView: {
        path: "src/a.ts",
        content: { text: "a\nb\nc\n", size: 6, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "a\nB!\nc\n", baseSize: 6, saving: false, error: null },
        baseline: "a\nb\nc\n",
      },
    });
    render(<RepoFileWorkspace />);
    // The modified line 2 surfaces on the far-right change ruler.
    expect(screen.getByTitle("Uncommitted changes — click to jump")).toBeInTheDocument();
  });

  it("shows no ruler when the buffer matches the baseline", () => {
    useRepo.setState({
      summary: SUMMARY,
      fileView: {
        path: "src/a.ts",
        content: { text: "a\nb\n", size: 4, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "a\nb\n", baseSize: 4, saving: false, error: null },
        baseline: "a\nb\n",
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.queryByTitle("Uncommitted changes — click to jump")).toBeNull();
  });

  it("reverts the draft back to the saved text", () => {
    openEditable();
    render(<RepoFileWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", { name: "File contents" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "changed" } });
    expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(textarea.value).toBe("const x = 1\n");
  });
});
