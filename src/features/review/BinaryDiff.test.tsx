import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BinaryBlob, FileDiff } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { BinaryDiff } from "./BinaryDiff";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// A 1×1 transparent PNG, base64-encoded — enough for the <img> data URL.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false } });
  invokeMock.mockImplementation((command: string): Promise<BinaryBlob> => {
    if (command === "read_binary_blob") {
      return Promise.resolve({ base64: PNG_B64, size: 70, truncated: false });
    }
    return Promise.reject(new Error(`unexpected invoke: ${command}`));
  });
});

describe("BinaryDiff", () => {
  it("shows a size delta and before/after previews for a modified image", async () => {
    const diff: FileDiff = {
      path: "assets/logo.png",
      status: "M",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      oldSize: 1024,
      newSize: 2048,
      oldOid: "a".repeat(40),
      newOid: "b".repeat(40),
    };
    render(<BinaryDiff diff={diff} />);

    // Type + change-kind card.
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("PNG image")).toBeInTheDocument();
    // old → new (+delta) summary.
    expect(screen.getByText(/1\.0 KB.*2\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/\(\+1\.0 KB\)/)).toBeInTheDocument();

    // Both sides preview (oldOid + newOid ⇒ before/after).
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    expect(invokeMock).toHaveBeenCalledWith(
      "read_binary_blob",
      expect.objectContaining({ oid: "a".repeat(40) }),
    );
  });

  it("renders a type + size card without a preview for a non-image binary", () => {
    const diff: FileDiff = {
      path: "docs/spec.pdf",
      status: "A",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      newSize: 4096,
    };
    render(<BinaryDiff diff={diff} />);

    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("PDF document")).toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows a single 'Removed' preview for a deleted image", async () => {
    const diff: FileDiff = {
      path: "assets/old.png",
      status: "D",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      oldSize: 512,
      oldOid: "c".repeat(40),
    };
    render(<BinaryDiff diff={diff} />);

    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.queryByText("After")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith(
      "read_binary_blob",
      expect.objectContaining({ oid: "c".repeat(40) }),
    );
  });

  it("shows a 'too large to preview' notice when the blob exceeds the cap", async () => {
    invokeMock.mockImplementation((command: string): Promise<BinaryBlob> => {
      if (command === "read_binary_blob") {
        // Backend omits the bytes and flags truncation for an oversized blob.
        return Promise.resolve({ base64: undefined, size: 20 * 1024 * 1024, truncated: true });
      }
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });
    const diff: FileDiff = {
      path: "assets/huge.png",
      status: "A",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      newSize: 20 * 1024 * 1024,
      newOid: "d".repeat(40),
    };
    render(<BinaryDiff diff={diff} />);

    await waitFor(() => expect(screen.getByText(/too large to preview/)).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows a 'Couldn't load preview' notice when the read fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_binary_blob") return Promise.reject(new Error("boom"));
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });
    const diff: FileDiff = {
      path: "assets/broken.png",
      status: "A",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      newSize: 70,
      newOid: "e".repeat(40),
    };
    render(<BinaryDiff diff={diff} />);

    await waitFor(() => expect(screen.getByText(/Couldn't load preview/)).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("reads the working-tree file by path when the new side has no oid", async () => {
    const diff: FileDiff = {
      path: "assets/new.png",
      status: "U",
      add: 0,
      del: 0,
      binary: true,
      truncated: false,
      hunks: [],
      newSize: 70,
    };
    render(<BinaryDiff diff={diff} />);

    await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
    expect(invokeMock).toHaveBeenCalledWith(
      "read_binary_blob",
      expect.objectContaining({ oid: null, file: "assets/new.png" }),
    );
  });
});
