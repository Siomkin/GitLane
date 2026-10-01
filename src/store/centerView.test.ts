import { describe, expect, it } from "vitest";

import { deriveCenterView, type CenterViewInput } from "./centerView";

/** Baseline: history tab, nothing overlaid — the default view. */
const base: CenterViewInput = {
  inConflict: false,
  leftTab: "history",
  comparing: false,
  fileHistoryOpen: false,
  stackedReviewOpen: false,
  fileViewOpen: false,
  changesAll: false,
  selectedFileSource: null,
};

describe("deriveCenterView", () => {
  it("defaults to the history graph", () => {
    expect(deriveCenterView(base)).toBe("history");
  });

  it("lets an active operation supersede every other view", () => {
    // Conflict resolution blocks the repo — it must win over any tab/overlay.
    expect(
      deriveCenterView({
        ...base,
        inConflict: true,
        leftTab: "pulls",
        comparing: true,
        stackedReviewOpen: true,
        selectedFileSource: "commit",
      }),
    ).toBe("conflict");
  });

  it("shows the PR detail on the pulls tab", () => {
    expect(deriveCenterView({ ...base, leftTab: "pulls" })).toBe("pulls");
  });

  it("raises a history inspection over the pulls tab and the stacked review", () => {
    expect(deriveCenterView({ ...base, comparing: true })).toBe("inspect");
    expect(deriveCenterView({ ...base, fileHistoryOpen: true, stackedReviewOpen: true })).toBe(
      "inspect",
    );
  });

  it("raises the stacked review over the tab views", () => {
    expect(deriveCenterView({ ...base, stackedReviewOpen: true, leftTab: "changes" })).toBe(
      "stacked",
    );
  });

  it("raises an open repository file over the tab views, below the overlays", () => {
    expect(deriveCenterView({ ...base, fileViewOpen: true })).toBe("file");
    expect(deriveCenterView({ ...base, fileViewOpen: true, leftTab: "changes" })).toBe("file");
    // A stacked review opened later shows on top (openRepoFile closes it for
    // the reverse order), and a history inspection outranks both.
    expect(deriveCenterView({ ...base, fileViewOpen: true, stackedReviewOpen: true })).toBe("stacked");
    expect(deriveCenterView({ ...base, fileViewOpen: true, comparing: true })).toBe("inspect");
  });

  it("splits the changes tab into all-files vs single-file review", () => {
    expect(deriveCenterView({ ...base, leftTab: "changes", changesAll: true })).toBe("changes");
    expect(deriveCenterView({ ...base, leftTab: "changes", changesAll: false })).toBe("review");
  });

  it("reviews a committed file in place of the graph on the history tab", () => {
    expect(deriveCenterView({ ...base, selectedFileSource: "commit" })).toBe("review-commit");
  });

  it("keeps the graph for a working-tree file selection (the inspector shows it)", () => {
    expect(deriveCenterView({ ...base, selectedFileSource: "staged" })).toBe("history");
    expect(deriveCenterView({ ...base, selectedFileSource: "unstaged" })).toBe("history");
  });
});
