import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { validateBranchName } from "@/lib/refName";
import { SearchIcon } from "@/components/ui/icons";
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

  const trimmedName = name.trim();
  const validationError = trimmedName ? validateBranchName(trimmedName) : null;

  const submit = () => {
    if (!trimmedName || validationError) return;
    setOpen(false);
    void run(() => createBranchAt(trimmedName, start ?? undefined));
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
        {validationError && (
          <div className="mt-2 text-[12px] text-rose-500">{validationError}</div>
        )}
        <div className="mt-[18px] flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!trimmedName || !!validationError}
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
            {confirm.details.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
        {confirm.warnings && confirm.warnings.length > 0 && (
          <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
            {confirm.warnings.map((line, i) => (
              <div key={i}>{line}</div>
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
 * webview. The action lives in `prompt.onSubmit`, fired with the trimmed value.
 *
 * When the request carries `options`, the field becomes a searchable picker
 * (like the branch navigator): the input filters a clickable list and selecting
 * a row submits its value, so the user picks a ref instead of typing it. */
export function PromptDialog() {
  const prompt = useUi((s) => s.prompt);
  const closePrompt = useUi((s) => s.closePrompt);
  const [value, setValue] = useState("");
  const [highlight, setHighlight] = useState(0);

  const options = prompt?.options ?? null;

  // Seed (and reset) the field whenever a new prompt opens. With options the
  // input is a search box (starts empty) and `defaultValue` pre-highlights its
  // row instead of pre-filling text.
  useEffect(() => {
    if (prompt?.options) {
      setValue("");
      const i = prompt.defaultValue
        ? prompt.options.findIndex((o) => o.value === prompt.defaultValue)
        : -1;
      setHighlight(i >= 0 ? i : 0);
    } else {
      setValue(prompt?.defaultValue ?? "");
      setHighlight(0);
    }
  }, [prompt]);

  if (!prompt) return null;

  const query = value.trim().toLowerCase();
  const filtered = options
    ? options.filter(
        (o) =>
          !query ||
          o.value.toLowerCase().includes(query) ||
          (o.label ?? "").toLowerCase().includes(query),
      )
    : [];
  // Clamp the highlight to the live filtered list so a shrinking list never
  // points past the end.
  const active = filtered.length ? Math.min(highlight, filtered.length - 1) : -1;

  // A synchronous validity check on the typed value (create/rename branch use
  // this). Only meaningful for the plain text input — never with a picker or the
  // multiline editor. Blocks submit and shows an inline message.
  const validationError =
    !options && !prompt.multiline && prompt.validate && value.trim() !== ""
      ? prompt.validate(value.trim())
      : null;

  const fire = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // A failed validator blocks submission (the button is also disabled, but a
    // keyboard Enter reaches here directly).
    if (!options && !prompt.multiline && prompt.validate && prompt.validate(trimmed)) return;
    // Close THIS prompt first, then run onSubmit — so a handler that opens a
    // follow-up prompt (e.g. the two-step annotated-tag flow) isn't immediately
    // clobbered by a trailing closePrompt() that would null the reopened prompt.
    const onSubmit = prompt.onSubmit;
    closePrompt();
    onSubmit(trimmed);
  };

  // With options, prefer the highlighted row; fall back to the typed value so a
  // ref outside the list (a SHA, HEAD~1) is still reachable.
  const submit = () => fire(options && active >= 0 ? filtered[active].value : value);
  const canSubmit = options
    ? filtered.length > 0 || value.trim() !== ""
    : value.trim() !== "" && !validationError;

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
        ) : options ? (
          <div className="mt-4">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-black/10 bg-transparent px-2.5 focus-within:border-[color:var(--accent)] dark:border-white/10">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <input
                autoFocus
                role="combobox"
                aria-expanded
                aria-controls="prompt-options"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHighlight((h) => Math.min(h + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHighlight((h) => Math.max(h - 1, 0));
                  } else if (e.key === "Enter") {
                    submit();
                  } else if (e.key === "Escape") {
                    closePrompt();
                  }
                }}
                placeholder={prompt.placeholder ?? "Search…"}
                className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
              />
            </div>
            <div
              id="prompt-options"
              role="listbox"
              className="mt-2 max-h-[260px] overflow-auto rounded-lg border border-black/5 dark:border-white/5"
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-neutral-400">No matches</div>
              ) : (
                filtered.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => fire(o.value)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]",
                      i === active
                        ? "bg-[var(--accent)] text-white"
                        : "text-neutral-700 hover:bg-black/[0.04] dark:text-neutral-200 dark:hover:bg-white/[0.05]",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label ?? o.value}</span>
                    {o.hint && (
                      <span className={cn("shrink-0 text-[11px]", i === active ? "text-white/75" : "text-neutral-400")}>
                        {o.hint}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
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
        {validationError && (
          <div className="mt-2 text-[12px] text-rose-500">{validationError}</div>
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
            disabled={!canSubmit}
            className="h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45"
          >
            {prompt.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
