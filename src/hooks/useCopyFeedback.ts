import { useCallback, useEffect, useState } from "react";

/** "Copied" feedback for a clipboard button. `copied` turns true only once the
 * write has resolved, and clears itself 1.5 s later. `copy` resolves whether
 * the text actually reached the clipboard (false when the write rejects or the
 * clipboard is unavailable), so a caller can act only on success. */
export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    if (!navigator.clipboard) return false;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(true);
    return true;
  }, []);

  const reset = useCallback(() => setCopied(false), []);

  return { copied, copy, reset };
}
