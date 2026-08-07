import {
  DIALOG_LAYER,
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "@/components/chrome/overlays/dialogs/frame";
import { operationLabel } from "@/store/operation";
import type { ActiveOperationKind } from "@/store/repo";

const abortBody = (kind: ActiveOperationKind) => {
  if (kind === "carry") {
    return "This discards the conflicted changes and restores the branch to its tip. Your carried work is preserved in a stash, so nothing is lost — you can re-apply it later.";
  }
  const verb = operationLabel(kind).toLowerCase();
  return `This runs git ${kind} --abort and restores your branch to where it was before the ${verb} started. Your staged resolutions will be discarded.`;
};

export const AbortConfirm = ({
  kind,
  onCancel,
  onConfirm,
}: {
  kind: ActiveOperationKind;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const title = `Abort ${operationLabel(kind).toLowerCase()}?`;
  return (
    <ModalFrame z={DIALOG_LAYER.Top} label={title} onDismiss={onCancel}>
      <DialogTitle>{title}</DialogTitle>
      <p className="mt-2 text-pretty text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {abortBody(kind)}
      </p>
      <DialogFooter>
        <DialogCancelButton onClick={onCancel}>Keep resolving</DialogCancelButton>
        <DialogPrimaryButton danger onClick={onConfirm}>
          Abort {operationLabel(kind).toLowerCase()}
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
};
