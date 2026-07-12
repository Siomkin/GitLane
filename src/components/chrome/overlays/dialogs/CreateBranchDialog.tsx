import { useState } from "react";
import { validateBranchName } from "@/lib/refName";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "../shared";
import {
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  DialogValidationError,
  ModalFrame,
} from "./frame";

export function CreateBranchDialog() {
  const open = useUi((s) => s.createBranchOpen);
  if (!open) return null;
  return <CreateBranchDialogBody />;
}

function CreateBranchDialogBody() {
  const start = useUi((s) => s.createBranchStart);
  const setOpen = useUi((s) => s.setCreateBranchOpen);
  const summary = useRepo((s) => s.summary);
  const createBranchAt = useRepo((s) => s.createBranchAt);
  const run = useBranchOp();
  const [name, setName] = useState("");

  const base = start ?? summary?.headBranch ?? "HEAD";

  const trimmedName = name.trim();
  const validationError = trimmedName ? validateBranchName(trimmedName) : null;

  const submit = () => {
    if (!trimmedName || validationError) return;
    setOpen(false);
    void run(() => createBranchAt(trimmedName, start ?? undefined));
  };

  return (
    <ModalFrame z="z-[60]" label="Create branch" onDismiss={() => setOpen(false)}>
      <DialogTitle>Create branch</DialogTitle>
      <div className="mt-1 text-[12.5px] text-neutral-400">
        Branches from <span className="font-semibold text-[color:var(--accent)]">{base}</span>
      </div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="feature/my-branch"
        className="mt-4 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
      />
      {validationError && <DialogValidationError>{validationError}</DialogValidationError>}
      <DialogFooter>
        <DialogCancelButton onClick={() => setOpen(false)} />
        <DialogPrimaryButton onClick={submit} disabled={!trimmedName || !!validationError}>
          Create branch
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}
