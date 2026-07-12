// A monospace command row with a copy button — used in the connect paths
// ("run `gh auth login`"). Clipboard via the webview's navigator API; no Tauri
// clipboard plugin is needed for plain text.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-black/[0.03] pl-3 pr-1.5 dark:border-white/10 dark:bg-white/[0.05]">
      <code className="flex-1 truncate font-mono text-[12.5px] text-neutral-700 dark:text-neutral-200">{command}</code>
      <button type="button"
        onClick={copy}
        className={cn(
          "shrink-0 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-semibold text-neutral-500 transition hover:bg-black/[0.06] dark:text-neutral-400 dark:hover:bg-white/10",
          focusRing,
        )}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
