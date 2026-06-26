import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "./shared";

export function CreateBranchDialog() {
  const open = useUi((s) => s.createBranchOpen);
  const start = useUi((s) => s.createBranchStart);
  const setOpen = useUi((s) => s.setCreateBranchOpen);
  const summary = useRepo((s) => s.summary);
  const createBranchAt = useRepo((s) => s.createBranchAt);
  const run = useBranchOp();
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  if (!open) return null;
  const base = start ?? summary?.headBranch ?? "HEAD";

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setOpen(false);
    void run(() => createBranchAt(trimmed, start ?? undefined));
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">Create branch</div>
        <div className="mt-1 text-[12.5px] text-neutral-400">
          Branches from <span className="font-semibold text-[color:var(--accent)]">{base}</span>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="feature/my-branch"
          className="mt-4 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
        />
        <div className="mt-[18px] flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim()}
            className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            Create branch
          </button>
        </div>
      </div>
    </div>
  );
}
/** In-app confirmation modal for destructive actions (drop stash, delete
 * branch, hard reset). Replaces native `window.confirm`, which is unreliable in
 * the Tauri webview. The triggering action lives in `confirm.onConfirm`. */
export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const closeConfirm = useUi((s) => s.closeConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter is handled by the autofocused Confirm button's native activation;
      // handling it here too would invoke onConfirm twice.
      if (e.key === "Escape") closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, closeConfirm]);

  if (!confirm) return null;

  const accept = () => {
    confirm.onConfirm();
    closeConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={closeConfirm}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800"
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{confirm.title}</div>
        {confirm.message && (
          <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">{confirm.message}</div>
        )}
        {confirm.details && confirm.details.length > 0 && (
          <div className="mt-3 rounded-xl border border-black/10 bg-black/[0.025] p-3 text-[12px] leading-relaxed text-neutral-600 dark:border-white/10 dark:bg-white/[0.035] dark:text-neutral-300">
            {confirm.details.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
        {confirm.warnings && confirm.warnings.length > 0 && (
          <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
            {confirm.warnings.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
        <div className="mt-[18px] flex justify-end gap-2">
          <button
            onClick={closeConfirm}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={accept}
            className={cn(
              "h-9 rounded-lg px-4 text-[13px] font-medium text-white hover:brightness-110",
              confirm.danger ? "bg-rose-500" : "bg-[var(--accent)]",
            )}
          >
            {confirm.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** In-app text-input modal for rename / tag / squash-message / new-branch
 * prompts. Replaces native `window.prompt`, which is unreliable in the Tauri
 * webview. The action lives in `prompt.onSubmit`, fired with the trimmed value. */
export function PromptDialog() {
  const prompt = useUi((s) => s.prompt);
  const closePrompt = useUi((s) => s.closePrompt);
  const [value, setValue] = useState("");

  // Seed (and reset) the field whenever a new prompt opens.
  useEffect(() => {
    setValue(prompt?.defaultValue ?? "");
  }, [prompt]);

  if (!prompt) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Close THIS prompt first, then run onSubmit — so a handler that opens a
    // follow-up prompt (e.g. the two-step annotated-tag flow) isn't immediately
    // clobbered by a trailing closePrompt() that would null the reopened prompt.
    const onSubmit = prompt.onSubmit;
    closePrompt();
    onSubmit(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/30 backdrop-blur-sm"
      onClick={closePrompt}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800",
          prompt.multiline ? "w-[min(860px,calc(100vw-56px))]" : "w-[420px]",
        )}
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{prompt.title}</div>
        {prompt.message && (
          <div className="mt-1 text-[12.5px] leading-relaxed text-neutral-400">{prompt.message}</div>
        )}
        {prompt.multiline ? (
          <textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              if (e.key === "Escape") closePrompt();
            }}
            placeholder={prompt.placeholder}
            className="mt-4 h-[min(56vh,460px)] min-h-[320px] w-full resize-y rounded-lg border border-black/10 bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
          />
        ) : (
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") closePrompt();
            }}
            placeholder={prompt.placeholder}
            className="mt-4 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-[13.5px] text-neutral-800 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-100"
          />
        )}
        <div className="mt-[18px] flex justify-end gap-2">
          <button
            onClick={closePrompt}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            {prompt.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
