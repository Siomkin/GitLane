import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "./ui";

// View-routing transitions (GL-155): the tab state lives here so store actions
// — not component effects — own its transitions.
beforeEach(() => {
  useUi.setState({
    leftTab: "history",
    changesAll: false,
    stackedReview: null,
    navOpen: false,
    reviewNotes: [],
    agentMessageOpen: false,
    histSearchOpen: false,
    histQuery: "",
    histFilter: "all",
    histFilterOpen: false,
    onboardingOpen: false,
  });
});

describe("view-tab transitions", () => {
  it("openChangesView lands on the changes tab in the requested flavour", () => {
    useUi.getState().openChangesView(true);
    expect(useUi.getState().leftTab).toBe("changes");
    expect(useUi.getState().changesAll).toBe(true);

    useUi.getState().openChangesView();
    expect(useUi.getState().changesAll).toBe(false);
  });

  it("onWorkingTreeClean leaves the changes view but never touches other tabs", () => {
    useUi.setState({ leftTab: "changes" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("history");

    useUi.setState({ leftTab: "pulls" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("pulls");
  });

  it("onRepoSwitched resets the view, history filters, notes, and transient chrome", () => {
    useUi.setState({
      leftTab: "changes",
      changesAll: true,
      // Outranks the history tab in deriveCenterView — a leftover one would
      // render the previous repo's oid against the new repo.
      stackedReview: { oid: "abc123", title: "Old repo commit" },
      navOpen: true,
      reviewNotes: [
        {
          id: "work#a.ts#R1-R1",
          surface: "work",
          file: "a.ts",
          side: "R",
          line: 1,
          fromRef: "R1",
          toRef: "R1",
          lineRef: "R1",
          code: "x",
          body: "note",
        },
      ],
      agentMessageOpen: true,
      histSearchOpen: true,
      histQuery: "fix",
      histFilter: "merges",
      histFilterOpen: true,
      onboardingOpen: true,
    });

    useUi.getState().onRepoSwitched();

    const s = useUi.getState();
    expect(s.leftTab).toBe("history");
    expect(s.changesAll).toBe(false);
    expect(s.stackedReview).toBeNull();
    expect(s.navOpen).toBe(false);
    expect(s.reviewNotes).toEqual([]);
    expect(s.agentMessageOpen).toBe(false);
    expect(s.histSearchOpen).toBe(false);
    expect(s.histQuery).toBe("");
    expect(s.histFilter).toBe("all");
    expect(s.histFilterOpen).toBe(false);
    expect(s.onboardingOpen).toBe(false);
  });
});
