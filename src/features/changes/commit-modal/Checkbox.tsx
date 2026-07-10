import { cn } from "../../../lib/cn";
import { CheckIcon } from "@/components/ui/icons";

// The include/exclude tick shared by the List and Tree views; `mixed` renders
// the directory-level "some children excluded" dash.
export const Checkbox = ({ on, mixed = false }: { on: boolean; mixed?: boolean }) => {
  return (
    <span
      className={cn(
        "grid h-[15px] w-[15px] shrink-0 cursor-pointer place-items-center rounded-[4px] border",
        on || mixed
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-700",
      )}
    >
      {on && !mixed && <CheckIcon className="h-2.5 w-2.5" />}
      {mixed && <span className="h-[2px] w-2 rounded-full bg-white" />}
    </span>
  );
};
