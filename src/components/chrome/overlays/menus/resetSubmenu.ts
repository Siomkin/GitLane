// The reset verb family, once (GL-359).
//
// ADR 0004 requires the reset block to read identically in the branch and commit
// menus. It did — because it was copy-pasted: `resetMode` was defined twice with
// the same name, same signature and same body apart from the target expression,
// and the three child rows below it were duplicated character-for-character,
// including the strings. An invariant enforced by copy-paste and a rendering
// test is one edit away from not holding, so it lives here instead.

import { api } from "@/lib/api";
import type { MenuItem } from "@/components/chrome/overlays/shared";
import type { ResetPreview } from "@/lib/api";
import { previewConfirm, type ConfirmFn, type HeadPrecondition } from "./previewConfirm";

export type ResetMode = "soft" | "mixed" | "hard";

/** The three modes, in the order the menu shows them, with the wording the
 * confirm dialog explains each one with. */
const MODES: { mode: ResetMode; label: string; message: string }[] = [
  {
    mode: "soft",
    label: "Soft — keep changes staged",
    message: "Soft reset — changes are kept staged.",
  },
  {
    mode: "mixed",
    label: "Mixed — keep changes unstaged",
    message: "Mixed reset — changes are kept in the working tree, unstaged.",
  },
  {
    mode: "hard",
    label: "Hard — discard changes",
    message:
      "Hard reset — all uncommitted working-tree changes will be permanently discarded.",
  },
];

export interface ResetSubmenuOptions {
  /** Confirm-dialog title, e.g. `Reset main to c2abcde?`. Display only, and
   * deliberately not derived from `branch`: a detached checkout resets with a
   * null branch but must still read "HEAD" rather than "null". */
  title: string;
  /** Branch being moved, or null when detached — the `resetBranchTo` operand. */
  branch: string | null;
  /** Commit the branch is reset to. */
  oid: string;
  repoPath: string | null;
  requestConfirm: ConfirmFn;
  /** Runs the write and toasts its failure (`useBranchOp`). */
  run: (op: () => Promise<string>) => void;
  /** Guards the write against a HEAD that moved since the menu opened. */
  headPrecondition: HeadPrecondition;
  resetBranchTo: (
    branch: string | null,
    oid: string,
    mode: ResetMode,
    preview: ResetPreview,
  ) => Promise<string>;
}

/** The three mode rows, ready to hang under a menu's Reset expander. */
export function resetSubmenu(opts: ResetSubmenuOptions): MenuItem[] {
  const { title, branch, oid, repoPath, requestConfirm, run, headPrecondition, resetBranchTo } = opts;
  return MODES.map(({ mode, label, message }) => ({
    label,
    // Only `hard` destroys work, so only `hard` is always rose. The expander
    // above carries `tone: "danger"` for the group as a whole.
    danger: mode === "hard",
    onClick: () =>
      void previewConfirm<ResetPreview>({
        requestConfirm,
        title,
        message,
        confirmLabel: `Reset (${mode})`,
        danger: mode === "hard",
        preview: () =>
          repoPath
            ? api.previewReset(repoPath, oid, mode)
            : Promise.reject(new Error("No repository")),
        onConfirm: (preview) => void run(() => resetBranchTo(branch, oid, mode, preview)),
        headPrecondition,
      }),
  }));
}
