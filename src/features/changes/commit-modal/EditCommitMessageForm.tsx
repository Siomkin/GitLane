import { useState, type KeyboardEvent } from "react";

import {
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import {
  composeConventionalMessage,
  parseConventionalMessage,
  type ComposerMode,
  type ConventionalFields,
} from "@/lib/conventionalCommit";
import type { EditCommitMessageRequest } from "@/store/ui";
import { CommitMessageEditor } from "./CommitMessageEditor";

export function EditCommitMessageForm({
  request,
  mode,
  onModeChange,
  onClose,
}: {
  request: EditCommitMessageRequest;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  onClose: () => void;
}) {
  const [message, setMessage] = useState(request.defaultValue);
  const [fields, setFields] = useState<ConventionalFields>(() =>
    parseConventionalMessage(request.defaultValue),
  );

  const updateMessage = (next: string) => {
    setMessage(next);
    setFields(parseConventionalMessage(next));
  };

  const updateFields = (patch: Partial<ConventionalFields>) => {
    setFields((current) => {
      const next = { ...current, ...patch };
      setMessage(composeConventionalMessage(next));
      return next;
    });
  };

  const submit = () => {
    const value = message.trim();
    if (!value) return;
    onClose();
    request.onSubmit(value);
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
            onModeChange={onModeChange}
            msg={message}
            onMsgChange={updateMessage}
            fields={fields}
            onFieldsChange={updateFields}
            amend
            autoFocus
            selectOnFocus
          />
        </div>
        <DialogFooter>
          <DialogCancelButton onClick={onClose} />
          <DialogPrimaryButton onClick={submit} disabled={!message.trim()}>
            Update message
          </DialogPrimaryButton>
        </DialogFooter>
      </div>
    </ModalFrame>
  );
}
