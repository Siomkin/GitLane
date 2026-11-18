import type { ReactNode } from "react";
import { StepRow } from "./StepRow";
import type { StepStatus } from "./stepModel";

export interface StepListRow {
  label: string;
  status: StepStatus;
  /** Shown under the row, e.g. why a failed step failed. */
  note?: ReactNode;
}

/** The run checklist the step dialogs share (delete branch, delete branch &
 * worktree): one StepRow per step, an optional note under a row. */
export function StepList({ rows }: { rows: StepListRow[] }) {
  return (
    <div className="mt-5 flex flex-col gap-3.5 pb-1">
      {rows.map((row) => (
        <div key={row.label}>
          <StepRow label={row.label} status={row.status} />
          {row.note && (
            <div className="ml-[30px] mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-neutral-400">
              {row.note}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
