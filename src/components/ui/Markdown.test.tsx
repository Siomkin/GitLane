import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders the lazy renderer's output", async () => {
    render(<Markdown content={"**bold** text"} />);

    expect((await screen.findByText("bold")).tagName).toBe("STRONG");
  });

  it("renders the empty state synchronously", () => {
    render(<Markdown content={"  \n"} />);

    expect(screen.getByText("No description.")).toBeInTheDocument();
  });
});
