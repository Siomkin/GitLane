import { operationLabel } from "../../store/operation";
import type { ActiveOperationKind } from "../../store/repo";

const abortBody = (kind: ActiveOperationKind) => {
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
}) => (
  <div className="fixed inset-0 z-[80] grid place-items-center bg-black/30 p-8 backdrop-blur-sm">
    <div className="relative w-[420px] max-w-full rounded-2xl border border-black/10 bg-white p-5 shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800">
      <h3 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">
        Abort {operationLabel(kind).toLowerCase()}?
      </h3>
      <p className="mt-2 text-pretty text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {abortBody(kind)}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="h-9 rounded-lg px-4 text-[13px] font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          Keep resolving
        </button>
        <button
          onClick={onConfirm}
          className="h-9 rounded-lg bg-rose-500 px-4 text-[13px] font-medium text-white hover:brightness-110"
        >
          Abort {operationLabel(kind).toLowerCase()}
        </button>
      </div>
    </div>
  </div>
);
