// Folder module for the small store-driven dialogs (GL-183): one file per
// overlay contract, sharing the modal frame in ./frame. Consumers keep
// importing from `overlays` (or `overlays/dialogs`) — the export surface is
// unchanged from the old single-file dialogs.tsx.
export { CreateBranchDialog } from "./CreateBranchDialog";
export { ConfirmDialog } from "./ConfirmDialog";
export { PromptDialog } from "./PromptDialog";
