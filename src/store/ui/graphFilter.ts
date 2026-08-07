// The graph's text filter and its collapsed groups.
import { persistedKeys, type SliceSet } from "./slice";

export interface GraphFilterSlice {
  filter: string;
  collapsed: Record<string, boolean>;

  setFilter: (filter: string) => void;
  toggleCollapse: (key: string) => void;
}

/** Which groups are folded is a view preference; the query itself is not — it
 * starts empty each session, the same way the history search bar does. */
const PERSISTED = ["collapsed"] as const;

export const persistedGraphFilter = (s: GraphFilterSlice) => persistedKeys(s, PERSISTED);

export function createGraphFilterSlice(set: SliceSet<GraphFilterSlice>): GraphFilterSlice {
  return {
    filter: "",
    collapsed: {},

    setFilter: (filter) => set({ filter }),
    toggleCollapse: (key) =>
      set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
  };
}
