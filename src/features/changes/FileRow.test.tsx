import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileChange } from "../../lib/api";
import { FileRow } from "./FileRow";

const file: FileChange = { path: "src/lib/paths.ts", status: "M", add: 3, del: 1 };

// del is rendered with a Unicode minus (U+2212); accept either glyph.
const isDelCount = (t: string) => /^[-−]1$/.test(t);

describe("FileRow", () => {
  it("renders the basename and, when not compact, the directory", () => {
    render(<FileRow file={file} active={false} onClick={() => {}} />);
    expect(screen.getByText("paths.ts")).toBeInTheDocument();
    expect(screen.getByText("src/lib/")).toBeInTheDocument();
  });

  it("shows the directory in compact mode too (commit file lists keep their location)", () => {
    render(<FileRow file={file} active={false} onClick={() => {}} compact />);
    expect(screen.getByText("paths.ts")).toBeInTheDocument();
    expect(screen.getByText("src/lib/")).toBeInTheDocument();
  });

  it("shows the added/deleted counts and the status badge", () => {
    render(<FileRow file={file} active={false} onClick={() => {}} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText(isDelCount)).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument();
  });

  it("fires onClick when the row is clicked", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<FileRow file={file} active={false} onClick={onClick} />);
    await user.click(screen.getByText("paths.ts"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fires the action without also selecting the row", async () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <FileRow file={file} active={false} onClick={onClick} action={{ tone: "stage", onAction }} />,
    );
    // The action is a sibling button, not nested in the row — so it never
    // bubbles a row selection (the structural alternative to stopPropagation).
    await user.click(screen.getByRole("button", { name: "Stage file" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("labels the action by tone (stage vs unstage)", () => {
    const { rerender } = render(
      <FileRow file={file} active={false} onClick={() => {}} action={{ tone: "stage", onAction: () => {} }} />,
    );
    expect(screen.getByRole("button", { name: "Stage file" })).toBeInTheDocument();
    rerender(
      <FileRow file={file} active={false} onClick={() => {}} action={{ tone: "unstage", onAction: () => {} }} />,
    );
    expect(screen.getByRole("button", { name: "Unstage file" })).toBeInTheDocument();
  });

  it("activates the action from the keyboard (Enter)", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <FileRow file={file} active={false} onClick={() => {}} action={{ tone: "unstage", onAction }} />,
    );
    screen.getByRole("button", { name: "Unstage file" }).focus();
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
