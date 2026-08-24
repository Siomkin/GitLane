import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadDiffSnippet } from "./ThreadDiffSnippet";

const hunk = ["@@ -1,2 +1,3 @@", " keep", "-old", "+new"].join("\n");

describe("ThreadDiffSnippet", () => {
  it("paints header, context, add, and del lines from a hunk", () => {
    render(<ThreadDiffSnippet diffHunk={hunk} />);
    const snippet = screen.getByTestId("thread-diff-snippet");
    expect(snippet).toHaveTextContent("@@ -1,2 +1,3 @@");
    expect(snippet).toHaveTextContent("keep");
    expect(snippet).toHaveTextContent("old");
    expect(snippet).toHaveTextContent("new");
  });

  it("renders nothing when diffHunk is null", () => {
    const { container } = render(<ThreadDiffSnippet diffHunk={null} />);
    expect(screen.queryByTestId("thread-diff-snippet")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the hunk is unparseable", () => {
    const { container } = render(<ThreadDiffSnippet diffHunk="not a diff" />);
    expect(screen.queryByTestId("thread-diff-snippet")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
