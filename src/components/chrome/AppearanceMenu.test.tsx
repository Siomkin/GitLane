import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "@/store/ui";
import { AppearanceMenu } from "./AppearanceMenu";

beforeEach(() => {
  useUi.setState({ theme: "dark" });
});

describe("AppearanceMenu", () => {
  it("keeps the current preference in the trigger and lists only the other two", () => {
    useUi.setState({ theme: "system" });
    render(<AppearanceMenu />);
    fireEvent.click(screen.getByLabelText("Appearance: Auto"));
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((el) => el.getAttribute("aria-label"))).toEqual(["Light", "Dark"]);
    expect(screen.queryByRole("menuitemradio", { name: "Auto" })).toBeNull();
  });

  it("selecting Auto sets the preference to system and closes", () => {
    render(<AppearanceMenu />);
    fireEvent.click(screen.getByLabelText("Appearance: Dark"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }));
    expect(useUi.getState().theme).toBe("system");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByLabelText("Appearance: Auto")).toBeInTheDocument();
  });

  it("Escape closes without changing the preference", () => {
    render(<AppearanceMenu />);
    fireEvent.click(screen.getByLabelText("Appearance: Dark"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useUi.getState().theme).toBe("dark");
  });

  it("closes on an outside mousedown even when a target handler stops propagation", () => {
    render(<AppearanceMenu />);
    fireEvent.click(screen.getByLabelText("Appearance: Dark"));
    const outside = document.createElement("div");
    outside.addEventListener("mousedown", (e) => e.stopPropagation());
    document.body.append(outside);
    fireEvent.mouseDown(outside);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useUi.getState().theme).toBe("dark");
  });

  it("closes when the window loses focus", () => {
    render(<AppearanceMenu />);
    fireEvent.click(screen.getByLabelText("Appearance: Dark"));
    fireEvent.blur(window);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("trigger follows the stored preference, not the OS scheme", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) =>
      ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      useUi.setState({ theme: "system" });
      render(<AppearanceMenu />);
      expect(screen.getByLabelText("Appearance: Auto")).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
