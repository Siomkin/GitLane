// Shared button classes for the PR header action cluster (GL-187): the square
// utility button (external link, "..." overflow trigger) and the labeled
// outline button (lifecycle actions). Kept as plain class strings — not
// components — so each surface keeps full control of its markup.

export const utilBtn =
  "grid h-9 w-9 place-items-center rounded-lg border border-black/10 text-neutral-600 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";

export const outlineBtn =
  "flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";
