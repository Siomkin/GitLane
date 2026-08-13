// The read-only "this is what got staged" pane: line number + highlighted text,
// on the same 20px metrics as the editors above it, so switching from resolving
// to reviewing doesn't shift the rows.

import { Tokens } from "./ConflictLine";
import { tokenize } from "./conflictModel";

const ROW = "grid grid-cols-[40px_1fr] items-center font-mono text-[12px] leading-[20px]";
const NUM = "select-none pr-1.5 text-right text-neutral-300 dark:text-neutral-600";

export const StagedResult = ({ text }: { text: string }) => (
  <div className="min-h-0 flex-1 overflow-auto py-1">
    {text
      .replace(/\n$/, "")
      .split("\n")
      .map((line, i) => (
        <div key={i} className={ROW}>
          <span className={NUM}>{i + 1}</span>
          <Tokens tokens={tokenize(line)} />
        </div>
      ))}
  </div>
);
