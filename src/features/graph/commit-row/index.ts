// Folder module for the graph's hottest render path (GL-190): the memoized
// CommitRow plus the ref-pill subviews it composes — RefCluster (owns the
// group-expansion state), RefPill, CombinedRefPill, and the
// useBranchWorktreeName selector hook. Only CommitRow is public; the siblings
// are implementation details of the row.
export { CommitRow } from "./CommitRow";
