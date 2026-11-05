// Git's own output behind a friendly credential message, collapsed by default,
// so a failure can be diagnosed in the app without a terminal. The text is
// already secret-redacted by the backend before it crosses IPC.

export function GitOutputDetails({ detail }: { detail: string | null | undefined }) {
  if (!detail) return null;
  return (
    <details className="mt-1.5 text-[11.5px]">
      <summary className="cursor-pointer select-none font-semibold opacity-80">Details</summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.05] p-2 font-mono text-[11px] text-neutral-600 dark:bg-white/[0.06] dark:text-neutral-300">
        {detail}
      </pre>
    </details>
  );
}
