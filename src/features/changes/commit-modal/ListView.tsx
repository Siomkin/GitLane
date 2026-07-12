import { type FileChange } from "@/lib/api";
import { basename, dirname } from "@/lib/paths";
import { useUi } from "@/store/ui";
import { FileIcon } from "@/components/ui/icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ChangeCounts } from "@/components/ui/ChangeCounts";
import { Checkbox } from "./Checkbox";

export const ListView = ({ staged }: { staged: FileChange[] }) => {
  const excluded = useUi((s) => s.commitExcluded);
  const toggle = useUi((s) => s.toggleCommitFile);
  return (
    <div className="flex-1 space-y-0.5 overflow-auto p-3">
      {staged.map((f) => {
        const on = !excluded[f.path];
        return (
          <div
            key={f.path}
            className="flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <button
              type="button"
              onClick={() => toggle(f.path)}
              aria-label={`${on ? "Exclude" : "Include"} ${f.path} from commit`}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
            >
              <Checkbox on={on} />
            </button>
            <StatusBadge status={f.status} />
            <FileIcon path={f.path} size={16} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-neutral-700 dark:text-neutral-200">
                {basename(f.path)}
              </span>
              <span className="block truncate text-[11px] text-neutral-400">{dirname(f.path)}</span>
              {f.advanced && (
                <span className="block truncate text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                  {f.advanced.message}
                </span>
              )}
            </span>
            <ChangeCounts add={f.add} del={f.del} binary={f.binary} className="ml-auto shrink-0 text-xs" />
          </div>
        );
      })}
    </div>
  );
};
