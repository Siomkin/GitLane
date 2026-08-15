// The pull-request list selection and the create-PR form.

import type { PrFilter } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import type { MenuSlice } from "./menus";
import type { SliceSet } from "./slice";
import { persistedKeys } from "./slice";

export interface PrViewSlice {
  prFilter: PrFilter;
  prSelected: number | null;
  prTab: "info" | "diff" | "checks" | "commits";
  /** The "New pull request" modal raised from the PR list header. */
  createPrOpen: boolean;
  /** Exact dialog lifetime. Incremented on every open/close and repo switch so
   * a deferred submission from an older instance cannot close a newer form. */
  createPrGeneration: number;
  /** Head branch the form should open a pull request for. Null means the
   * checked-out branch — the PR list's "+" and the commit modal both mean
   * that; the graph's branch menu names the branch that was right-clicked. */
  createPrHead: string | null;

  setPrFilter: (filter: PrFilter) => void;
  selectPr: (num: number) => void;
  setPrTab: (tab: "info" | "diff" | "checks" | "commits") => void;
  openCreatePr: (head?: string) => void;
  /** Close the current form. When `generation` is supplied, no-op unless that
   * exact dialog instance is still current. */
  closeCreatePr: (generation?: number) => void;
}

/** The create-PR form. Its generation advances rather than resetting, so a
 * submission deferred by the old instance cannot close the next one. */
export const resetPrForm = (s: Pick<PrViewSlice, "createPrGeneration">) =>
  ({
    createPrOpen: false,
    createPrGeneration: s.createPrGeneration + 1,
    createPrHead: null,
  }) satisfies Partial<PrViewSlice>;

export const persistedPrView = (s: PrViewSlice) => persistedKeys(s, ["prFilter"]);

/** The create-PR form owns the keyboard while it is up. */
export const overlayOpenPrView = (s: PrViewSlice) => s.createPrOpen;

export function createPrViewSlice(
  set: SliceSet<PrViewSlice & Pick<MenuSlice, "menu">>,
  get: () => PrViewSlice,
): PrViewSlice {
  return {
    prFilter: "open",
    prSelected: null,
    prTab: "info",
    createPrOpen: false,
    createPrGeneration: 0,
    createPrHead: null,

    setPrFilter: (filter) => {
      if (get().prFilter === filter) return;
      set({ prFilter: filter });
      // The list holds all states already, but a tab change is a deliberate user
      // action — refresh so the chosen view is current and the spinner shows.
      void usePulls.getState().loadPullRequests();
    },
    selectPr: (num) => set({ prSelected: num, prTab: "info" }),
    setPrTab: (tab) => set({ prTab: tab }),
    openCreatePr: (head) =>
      set((s) =>
        s.createPrOpen
          ? {}
          : {
              menu: null,
              createPrOpen: true,
              createPrGeneration: s.createPrGeneration + 1,
              createPrHead: head ?? null,
            },
      ),
    closeCreatePr: (generation) =>
      set((s) =>
        generation !== undefined && generation !== s.createPrGeneration
          ? {}
          : {
              createPrOpen: false,
              createPrGeneration: s.createPrGeneration + 1,
              createPrHead: null,
            },
      ),
  };
}
