import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function AiActionsMenu({
  children,
  align = "left",
  width,
}: {
  children: ReactNode;
  align?: "left" | "right";
  width: string;
}) {
  return (
    <div
      className={cn(
        "gp-pop absolute top-11 z-30 rounded-xl border border-black/10 bg-white p-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800",
        align === "right" ? "right-0" : "left-0",
        width,
      )}
    >
      {children}
    </div>
  );
}
