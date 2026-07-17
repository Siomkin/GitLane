// Shared types for the changed-files list (flat Path mode / collapsible Tree
// mode) used by every changed-files surface — the selected-commit inspector, the
// working-changes inspector, and the merged multi-commit selection (GL-28).

/** The two ways a changed-files list can be laid out — the `FileListView` const
 * (values) and its type. Canonical definition lives in `@/lib/ui` so the ui
 * store can share it without importing from features. */
export { FileListView } from "@/lib/ui";

/** A stage / unstage affordance attached to a file row or a folder roll-up.
 * `disabledReason`, when set, blocks the action and is shown as the tooltip. */
export interface FileRowAction {
  tone: "stage" | "unstage";
  onAction: () => void;
  disabledReason?: string | null;
}
