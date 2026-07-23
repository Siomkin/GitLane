import { useUi } from "@/store/ui";
import { EditCommitMessageForm } from "./EditCommitMessageForm";

/** Reword editor for the unpublished HEAD commit. It deliberately reuses the
 * commit composer's Message / Conventional surface without its agent actions. */
export function EditCommitMessageDialog() {
  const request = useUi((state) => state.editCommitMessage);
  const close = useUi((state) => state.closeEditCommitMessage);
  const mode = useUi((state) => state.commitComposerMode);
  const setMode = useUi((state) => state.setCommitComposerMode);

  if (!request) return null;

  return (
    <EditCommitMessageForm
      request={request}
      mode={mode}
      onModeChange={setMode}
      onClose={close}
    />
  );
}
