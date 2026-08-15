import { describe, expect, it } from "vitest";

import {
  deriveShellLayout,
  deriveShellScreen,
  screenShowsRepoState,
  shellLayoutColumns,
  type ShellLayoutInput,
} from "./shellLayout";

/** Baseline: history tab — the default center + inspector grid. */
const base: ShellLayoutInput = { view: "history" };

describe("deriveShellLayout", () => {
  it("defaults to the center + right-inspector split", () => {
    expect(deriveShellLayout(base)).toBe("inspect");
  });

  it("collapses every overlay/inspection view onto the inspector split", () => {
    // Compare, file history, stacked review, file view, changes tab, and a
    // committed-file review all live in the same grid — only the panes differ.
    for (const view of ["inspect", "stacked", "file", "changes", "review", "review-commit"] as const) {
      expect(deriveShellLayout({ view })).toBe("inspect");
    }
  });

  it("gives the pulls tab the two-pane PR layout", () => {
    expect(deriveShellLayout({ view: "pulls" })).toBe("pulls");
  });

  it("lets a conflict operation take over the whole center", () => {
    expect(deriveShellLayout({ view: "conflict" })).toBe("conflict");
    expect(deriveShellLayout({ view: "pulls" })).not.toBe("conflict");
  });
});

describe("shellLayoutColumns", () => {
  it("maps each layout key to one column template", () => {
    const widths = { leftWidth: 560, rightWidth: 420 };
    expect(shellLayoutColumns("conflict", widths)).toBe("minmax(0,1fr)");
    expect(shellLayoutColumns("pulls", widths)).toBe("560px 6px minmax(0,1fr)");
    expect(shellLayoutColumns("inspect", widths)).toBe("minmax(0,1fr) 6px clamp(280px, 34vw, 420px)");
  });

  it("follows the user's resizable pane widths", () => {
    expect(shellLayoutColumns("pulls", { leftWidth: 320, rightWidth: 420 })).toBe(
      "320px 6px minmax(0,1fr)",
    );
    expect(shellLayoutColumns("inspect", { leftWidth: 560, rightWidth: 900 })).toBe(
      "minmax(0,1fr) 6px clamp(280px, 34vw, 900px)",
    );
  });
});

describe("deriveShellScreen", () => {
  it("shows the workspace once a summary is loaded, ahead of every recovery state", () => {
    expect(
      deriveShellScreen({ hasSummary: true, missingRepo: true, restoringSession: true }),
    ).toBe("workspace");
  });

  it("replaces the workspace with the recovery screen for a missing repo", () => {
    expect(deriveShellScreen({ hasSummary: false, missingRepo: true, restoringSession: true })).toBe(
      "missing-repo",
    );
  });

  it("shows the restoring loader before onboarding", () => {
    expect(deriveShellScreen({ hasSummary: false, missingRepo: false, restoringSession: true })).toBe(
      "restoring",
    );
  });

  it("falls back to onboarding when nothing else applies", () => {
    expect(deriveShellScreen({ hasSummary: false, missingRepo: false, restoringSession: false })).toBe(
      "onboarding",
    );
  });
});

describe("screenShowsRepoState", () => {
  it("covers the workspace and missing-repo screens, not the restoring/onboarding ones", () => {
    expect(screenShowsRepoState("workspace")).toBe(true);
    expect(screenShowsRepoState("missing-repo")).toBe(true);
    expect(screenShowsRepoState("restoring")).toBe(false);
    expect(screenShowsRepoState("onboarding")).toBe(false);
  });
});
