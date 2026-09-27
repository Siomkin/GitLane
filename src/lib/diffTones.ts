// The add / delete colours every diff and change painter shares — the review
// diff rails and tints, the split view, the minimap, the file viewer's gutter
// and ruler, the staged checkbox and PR thread snippets. One module, so a
// palette change is one edit and the two sides can't drift (there used to be
// two different deletion reds). The app's brand green / rose, consistent with
// the graph.

export const DIFF_ADD = "#2e9e62";
export const DIFF_DEL = "#e0626f";
/** Line-background tints behind added / deleted rows. */
export const DIFF_ADD_BG = "rgba(46,158,98,0.11)";
export const DIFF_DEL_BG = "rgba(225,98,111,0.12)";
