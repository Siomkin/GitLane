import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "../../store/repo";
import { RepoFileWorkspace } from "./RepoFileWorkspace";
import { formatBytes, splitLinesCapped, utf8Bytes } from "./format";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ fileView: null });
});

describe("RepoFileWorkspace", () => {
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

  it("shows the binary notice instead of text", () => {
    useRepo.setState({
      fileView: {
        path: "logo.png",
        content: { size: 2048, truncated: false, binary: true },
        loading: false,
        error: null,
      },
    });
    render(<RepoFileWorkspace />);
    expect(screen.getByText("Binary file — no text preview.")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("flags a truncated read", () => {
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
  });

  it("offers a retry on a read failure", () => {
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      fileView: { path: "gone.ts", content: null, loading: false, error: "read failed" },
    });
    invokeMock.mockResolvedValue({ text: "back", size: 4, truncated: false, binary: false });
    render(<RepoFileWorkspace />);
    expect(screen.getByText("read failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(invokeMock).toHaveBeenCalledWith("repo_file_text", {
      path: "/r",
      file: "gone.ts",
      maxBytes: null,
    });
  });
});

describe("formatBytes", () => {
  it("scales through B / KB / MB", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // "é" is 2 UTF-8 bytes; "😀" is 4 — a plain .length would under/over-count.
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("splitLinesCapped", () => {
  it("returns every line and the true total when under the cap", () => {
    expect(splitLinesCapped("a\nb\nc", 10)).toEqual({ lines: ["a", "b", "c"], total: 3 });
    expect(splitLinesCapped("", 10)).toEqual({ lines: [""], total: 1 });
  });

  it("caps the materialized lines but still counts the true total", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const { lines, total } = splitLinesCapped(text, 50);
    expect(total).toBe(1000);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 0");
    expect(lines[49]).toBe("line 49");
  });
});
