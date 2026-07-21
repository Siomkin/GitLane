// Context-menu folder module (GL-156): one file per menu, with the shared
// destructive-preview guard in previewConfirm.ts and the prompt builders in
// prompts.ts. The barrel keeps the pre-split `overlays/menus` import surface.
//
// Importing the `api` object (canFastForward probes, preview* reads) is only
// allowed for the files named in the eslint allowlist (eslint.config.js, GL-58) —
// currently ActionMenu, BranchContextMenu (preview reads), CommitContextMenu,
// useBranchFastForwardProbe, and the shared useDiscardAllChanges hook
// (WipContextMenu now goes through that hook, GL-236).
// A new menu that adds a probe/preview read must be added there too, or
// `bun run lint` fails CI.
export { ActionMenu } from "./ActionMenu";
export { BranchContextMenu } from "./BranchContextMenu";
export { CommitContextMenu } from "./CommitContextMenu";
export { FileContextMenu } from "./FileContextMenu";
export { WipContextMenu } from "./WipContextMenu";
export { TagContextMenu } from "./TagContextMenu";
export { WorktreeContextMenu } from "./WorktreeContextMenu";
export { StashContextMenu } from "./StashContextMenu";
