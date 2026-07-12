// One connection method, framed as a distinct card so the methods read as
// separate options rather than a blur. The recommended method gets an accent
// border + badge; the rest are plain hairline cards under "Or connect another
// way". Every method — CLI, GCM/helper, SSH, install — uses this same frame.

import { cn } from "@/lib/cn";

export function MethodCard({
  icon,
  title,
  recommended = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  /** Accent the card + show a "Recommended" badge (the leading method). */
  recommended?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl bg-white p-3.5 dark:bg-neutral-900/40",
        recommended
          ? "border-2 border-[color:var(--accent)]/55"
          : "border border-black/[0.08] dark:border-white/[0.1]",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={recommended ? "text-[color:var(--accent)]" : "text-neutral-500 dark:text-neutral-400"}>
          {icon}
        </span>
        <span className="text-[13px] font-semibold text-neutral-900 dark:text-white">{title}</span>
        {recommended && (
          <span className="inline-flex h-[17px] items-center rounded-full bg-[color:var(--accent)]/12 px-2 text-[10px] font-semibold text-[color:var(--accent)]">
            Recommended
          </span>
        )}
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}
