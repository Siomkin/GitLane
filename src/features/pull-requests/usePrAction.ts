// Shared runner for PR write actions (merge, comment, review, lifecycle,
// create). Wraps a store action so every call surfaces gh's output as a toast
// — success on the first line, the raw error otherwise — and reports whether it
// succeeded so callers can clear their own input on success.

import { useCallback } from "react";
import { useUi } from "../../store/ui";

export function useRunPrAction() {
  const showToast = useUi((s) => s.showToast);
  return useCallback(
    async (run: () => Promise<string>, okMessage?: string): Promise<boolean> => {
      try {
        const out = await run();
        const firstLine = out.split("\n").find((l) => l.trim().length > 0);
        showToast(okMessage ?? firstLine ?? "Done", "ok");
        return true;
      } catch (e) {
        showToast(String(e), "error");
        return false;
      }
    },
    [showToast],
  );
}
