import { cn } from "@/lib/cn";

export const AdvancedRepoBanner = ({
  notices,
  variant = "inline",
}: {
  notices: string[];
  variant?: "inline" | "card";
}) => {
  if (notices.length === 0) return null;

  return (
    <div
      className={cn(
        "space-y-1 border-amber-500/20 bg-amber-500/[0.07] text-[12px] leading-5 text-amber-700 dark:text-amber-300",
        variant === "card"
          ? "rounded-lg border px-3 py-2"
          : "border-b px-4 py-2",
      )}
    >
      {notices.map((notice) => (
        <div key={notice}>{notice}</div>
      ))}
    </div>
  );
};
