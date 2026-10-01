import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useTerminals } from "@/store/terminals";
import { TerminalTabs } from "./TerminalTabs";

beforeEach(() => {
  useTerminals.setState({ byRepo: {} });
  useTerminals.getState().openTab("/repo");
  useTerminals.getState().openTab("/repo");
});

describe("TerminalTabs", () => {
  it("keeps each tab's close button outside its switch control", () => {
    render(<TerminalTabs repoPath="/repo" />);
    const [first] = useTerminals.getState().byRepo["/repo"]!.tabs;
    const tab = screen.getByRole("button", { name: `Switch to ${first!.title}` });
    const close = screen.getByRole("button", { name: `Close ${first!.title}` });
    expect(tab).not.toContainElement(close);
    expect(tab.querySelector("button")).toBeNull();
  });

  it("closing a tab does not also switch to it", () => {
    render(<TerminalTabs repoPath="/repo" />);
    const [first, second] = useTerminals.getState().byRepo["/repo"]!.tabs;
    expect(useTerminals.getState().byRepo["/repo"]!.activeId).toBe(second!.id);
    fireEvent.click(screen.getByRole("button", { name: `Close ${first!.title}` }));
    const repo = useTerminals.getState().byRepo["/repo"]!;
    expect(repo.tabs.map((t) => t.id)).toEqual([second!.id]);
    expect(repo.activeId).toBe(second!.id);
  });
});
