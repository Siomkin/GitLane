import { cn } from "@/lib/cn";
import { ChangesView } from "@/lib/ui";

const btn = (active: boolean) =>
  cn(
    "px-2.5 h-6 rounded-md",
    active
      ? "bg-white dark:bg-neutral-700 shadow-sm font-medium text-neutral-800 dark:text-neutral-100"
      : "text-neutral-500 dark:text-neutral-400",
  );

/** Include / Staging area switch for the Changes tab — the same segmented idiom
 * as the Path / Tree toggle. Both views edit the git index; this only picks how
 * the list and the diff present it. */
export function ChangesViewToggle({
  view,
  onChange,
}: {
  view: ChangesView;
  onChange: (view: ChangesView) => void;
}) {
  const include = view !== ChangesView.Staging;
  return (
    <div
      role="group"
      aria-label="Changes view"
      className="flex rounded-lg bg-black/[0.06] p-0.5 text-[12px] dark:bg-white/[0.06]"
    >
      <button
        type="button"
        aria-pressed={include}
        className={btn(include)}
        onClick={() => onChange(ChangesView.Include)}
      >
        Include
      </button>
      <button
        type="button"
        aria-pressed={!include}
        className={btn(!include)}
        onClick={() => onChange(ChangesView.Staging)}
      >
        Staging area
      </button>
    </div>
  );
}
