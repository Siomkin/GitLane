// A single toast card: a corner glow and tinted status-icon chip in the kind's
// colour, a bold title with optional body, and 0–2 action buttons. The chip is
// also the dismiss button, showing × on card hover or keyboard focus (except
// while a progress toast is in flight, which adds a fill track instead).

import { useNotifications, type Notification } from "@/store/notifications";
import { CloseIcon } from "@/components/ui/icons";
import { ToastIcon } from "./ToastIcon";
import { KIND_VISUAL } from "./model";

const CHIP = "grid h-[26px] w-[26px] flex-none place-items-center rounded-full";

export function ToastCard({ toast, paused }: { toast: Notification; paused: boolean }) {
  const dismiss = useNotifications((s) => s.dismiss);
  const v = KIND_VISUAL[toast.kind];
  const isProgress = toast.kind === "progress";
  const isError = toast.kind === "error";
  const actions = toast.actions?.slice(0, 2) ?? [];
  const chipStyle = { background: `color-mix(in srgb, ${v.soft} 55%, transparent)`, color: v.color };
  const pct =
    typeof toast.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(toast.progress * 100)))
      : null;

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className="group/toast pointer-events-auto flex w-full items-start gap-3 overflow-hidden rounded-xl border border-black/10 bg-[var(--elev)] px-3.5 py-3 shadow-[var(--shadow-pop)] dark:border-white/10"
      style={{
        animation: "nf-in 0.24s cubic-bezier(0.16,0.84,0.44,1)",
        backgroundImage: `radial-gradient(100% 120% at 0 0, color-mix(in srgb, ${v.color} 7%, var(--elev)), var(--elev) 55%)`,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className={isProgress ? "flex items-baseline justify-between gap-2" : undefined}>
          <div
            className={`text-[13px] font-semibold leading-snug text-[var(--textBright)]${
              toast.raw ? " max-h-[42vh] select-text overflow-y-auto whitespace-pre-wrap break-words" : ""
            }`}
          >
            {toast.title}
          </div>
          {isProgress && pct != null && (
            <div className="flex-none font-mono text-[11px] text-[var(--text3)]">{pct}%</div>
          )}
        </div>

        {toast.body && (
          <div className="mt-0.5 max-h-[42vh] select-text overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-normal text-[var(--text2)]">
            {toast.body}
          </div>
        )}

        {isProgress && (
          <div className="relative mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--bg3)]">
            {pct == null ? (
              <span
                className="absolute inset-y-0 w-[35%] rounded-full"
                style={{
                  background: v.color,
                  animation: "nf-indet 1.1s ease-in-out infinite",
                  animationPlayState: paused ? "paused" : "running",
                }}
                aria-hidden
              />
            ) : (
              <span
                className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
                style={{ background: v.color, width: `${pct}%` }}
                aria-hidden
              />
            )}
          </div>
        )}

        {actions.length > 0 && (
          <div className="mt-2.5 flex gap-2">
            {actions.map((a, i) => (
              <button
                key={`${a.label}-${i}`}
                type="button"
                onClick={() => {
                  a.onClick();
                  dismiss(toast.id);
                }}
                className={
                  a.variant === "ghost"
                    ? "rounded-[7px] px-2.5 py-[5px] text-[12px] font-medium text-[var(--text2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                    : "rounded-[7px] border border-black/15 bg-white px-2.5 py-[5px] text-[12px] font-medium text-[var(--text)] hover:bg-black/5 dark:border-white/20 dark:bg-white/10 dark:hover:bg-white/15"
                }
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {isProgress ? (
        <span className={CHIP} style={chipStyle}>
          <ToastIcon kind={toast.kind} />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss"
          className={`${CHIP} group/chip focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]`}
          style={chipStyle}
        >
          <span className="grid group-hover/toast:hidden group-focus-visible/chip:hidden">
            <ToastIcon kind={toast.kind} />
          </span>
          <CloseIcon className="hidden h-3.5 w-3.5 group-hover/toast:block group-focus-visible/chip:block" />
        </button>
      )}
    </div>
  );
}
