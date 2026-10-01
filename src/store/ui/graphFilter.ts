// The branch navigator's text filter. It is not persisted: the query starts
// empty each session, the same way the history search bar does.
import type { SliceSet } from "./slice";

export interface GraphFilterSlice {
  filter: string;

  setFilter: (filter: string) => void;
}

export function createGraphFilterSlice(set: SliceSet<GraphFilterSlice>): GraphFilterSlice {
  return {
    filter: "",

    setFilter: (filter) => set({ filter }),
  };
}
