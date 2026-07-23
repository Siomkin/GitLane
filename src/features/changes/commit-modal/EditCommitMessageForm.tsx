import { useState, type KeyboardEvent } from "react";

import {
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { ComposerMode } from "@/lib/conventionalCommit";
import type { EditCommitMessageRequest } from "@/store/ui";
import { CommitMessageEditor } from "./CommitMessageEditor";
import { useConventionalFields } from "./useConventionalFields";

export function EditCommitMessageForm({
  request,
  onClose,
}: {
  request: EditCommitMessageRequest;
  onClose: () => void;
}) {
  const [message, setMessage] = useState(request.defaultValue);
  const { fields, updateFields } = useConventionalFields(message, setMessage);
  const [mode, setMode] = useState<ComposerMode>(() =>
    fields.type ? ComposerMode.Conventional : ComposerMode.Message,
  );

  // Mirror the inline composer's readiness rule (`deriveCommitComposer`): in
  // Conventional mode a type/scope alone still composes a non-empty message
  // (`fix(ui):`), so the subject — not the composed text — is what must be set.
  const canSubmit =
    mode === ComposerMode.Conventional
      ? fields.subject.trim().length > 0
      : message.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onClose();
    request.onSubmit(message.trim());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <ModalFrame
      z="z-[80]"
      label="Edit commit message"
      panelClassName="w-[min(720px,calc(100vw-56px))]"
      onDismiss={onClose}
    >
      <div onKeyDown={handleKeyDown}>
        <DialogTitle>Edit commit message</DialogTitle>
        {request.message && (
          <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">
            {request.message}
          </div>
        )}
        <div className="mt-4">
          <CommitMessageEditor
            mode={mode}
            onModeChange={setMode}
            msg={message}
            onMsgChange={setMessage}
            fields={fields}
            onFieldsChange={updateFields}
            amend
            autoFocus
            bodyRows={8}
            messageRows={10}
          />
        </div>
        <DialogFooter>
          <DialogCancelButton onClick={onClose} />
          <DialogPrimaryButton onClick={submit} disabled={!canSubmit}>
            Update message
          </DialogPrimaryButton>
        </DialogFooter>
      </div>
    </ModalFrame>
  );
}
