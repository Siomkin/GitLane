import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
// Render as if inside the Tauri webview so external links route through the
// opener plugin (the helper falls back to window.open in a plain browser).
vi.mock("../../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/platform")>()),
  isTauri: true,
}));

afterEach(() => {
  openUrl.mockClear();
});

describe("Markdown", () => {
  it("renders GitHub HTML disclosure blocks instead of raw tags", () => {
    const content = `<details>
<summary>Release notes</summary>

<p>Dependabot body with <strong>important</strong> details.</p>
</details>`;

    const { container } = render(<Markdown content={content} />);

    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.getByText("important")).toBeInTheDocument();
    expect(container.querySelector("details")).toBeInTheDocument();
    expect(container.textContent).not.toContain("<details>");
    expect(container.textContent).not.toContain("<summary>");
  });

  it("keeps GFM tables, task lists, and blockquotes working", () => {
    const content = `> Quote

- [x] Done

| Package | Version |
| --- | --- |
| react | 19 |`;

    const { container } = render(<Markdown content={content} />);

    expect(container.querySelector("blockquote")).toHaveTextContent("Quote");
    expect(container.querySelector("input[type='checkbox']")).toBeDisabled();
    expect(screen.getByRole("table")).toHaveTextContent("Package");
    expect(screen.getByRole("table")).toHaveTextContent("react");
  });

  it("sanitizes unsafe HTML before it reaches the DOM", () => {
    const content = `<script>alert("x")</script>
<style>.x { color: red; }</style>
<p style="color:red" onmouseover="alert('x')">Safe text</p>
<a href="javascript:alert('x')" onclick="alert('x')">Unsafe link</a>
<picture><source srcset="https://tracker.example/pixel.png"><img src="https://tracker.example/fallback.png" alt="fallback"></picture>`;

    const { container } = render(<Markdown content={content} />);

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("style")).not.toBeInTheDocument();
    expect(container.querySelector("source")).not.toBeInTheDocument();
    expect(container.querySelector("picture")).not.toBeInTheDocument();
    expect(screen.getByText("Safe text")).not.toHaveAttribute("style");
    expect(screen.getByText("Unsafe link")).not.toHaveAttribute("href");
    expect(screen.getByText("fallback").tagName).toBe("SPAN");
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  it("loads only trusted images directly", () => {
    const { container } = render(
      <Markdown
        content={`![trusted](https://avatars.githubusercontent.com/u/1?v=4)

![blocked](https://tracker.example/pixel.png)

![inline](data:image/png;base64,aGVsbG8=)`}
      />,
    );

    const images = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("alt"));
    expect(images).toEqual(["trusted", "inline"]);
    expect(screen.getByText("blocked").tagName).toBe("SPAN");
  });

  it("blocks SVG and oversized data-image URIs but keeps small raster ones", () => {
    const oversized = `data:image/png;base64,${"A".repeat(300 * 1024)}`;
    const { container } = render(
      <Markdown
        content={`![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)

![huge](${oversized})

![png](data:image/png;base64,aGVsbG8=)

![jpeg](data:image/jpeg;base64,/9j/4AAQ==)

![webp](data:image/webp;base64,UklGRg==)`}
      />,
    );

    const images = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("alt"));
    expect(images).toEqual(["png", "jpeg", "webp"]);
    expect(screen.getByText("svg").tagName).toBe("SPAN");
    expect(screen.getByText("huge").tagName).toBe("SPAN");
  });

  it("renders Shields priority badges locally without loading the remote image", () => {
    const { container } = render(
      <Markdown content={`![P2 Badge](https://img.shields.io/badge/P2-yellow.svg) Preserve empty PR lists`} />,
    );

    expect(screen.getByText("P2")).toBeInTheDocument();
    expect(screen.getByText("Preserve empty PR lists")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("P2 Badge");
  });

  it("opens sanitized external links through the opener plugin only", () => {
    render(<Markdown content={`[safe](https://github.com/owner/repo) [unsafe](javascript:alert('x'))`} />);

    fireEvent.click(screen.getByText("safe"));
    fireEvent.click(screen.getByText("unsafe"));

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/owner/repo");
  });
});
