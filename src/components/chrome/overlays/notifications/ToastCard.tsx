// A single toast card. Renders every kind from Notifications.dc.html: tinted
// status-icon chip + 3px accent bar, a bold title with optional body, 0–2
// action buttons, an always-available dismiss (except while a progress toast is
// in flight), and a bottom timer bar for auto-dismissing toasts. Progress
// toasts swap the timer for a determinate/indeterminate fill track.

import { useNotifications, type Notification } from "@/store/notifications";
import { CloseIcon } from "@/components/ui/icons";
import { ToastIcon } from "./ToastIcon";
import { KIND_VISUAL, hasAccentBar } from "./model";

export function ToastCard({ toast, paused }: { toast: Notification; paused: boolean }) {
  const dismiss = useNotifications((s) => s.dismiss);
  const v = KIND_VISUAL[toast.kind];
  const isProgress = toast.kind === "progress";
  const isError = toast.kind === "error";
  const actions = toast.actions?.slice(0, 2) ?? [];
  const showTimer = toast.duration != null;
  const pct =
    typeof toast.progress === "number"
      ? Math.max(0, Math.min(100, Math.round(toast.progress * 100)))
      : null;

  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className="pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--elev)] px-3.5 py-3 shadow-[var(--shadow-pop)]"
      style={{ animation: "nf-in 0.24s cubic-bezier(0.16,0.84,0.44,1)" }}
    >
      {hasAccentBar(toast.kind) && (
        <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: v.color }} aria-hidden />
      )}

      <span
        className="grid h-[26px] w-[26px] flex-none place-items-center rounded-full"
        style={{ background: v.soft, color: v.color }}
      >
        <ToastIcon kind={toast.kind} />
      </span>

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
          <div className="mt-0.5 text-[12.5px] leading-normal text-[var(--text2)]">{toast.body}</div>
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
                    : "rounded-[7px] border border-[var(--border)] bg-[var(--elev)] px-2.5 py-[5px] text-[12px] font-medium text-[var(--text)] hover:bg-[var(--btnHover)]"
                }
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {!isProgress && (
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss"
          className="grid h-[22px] w-[22px] flex-none place-items-center rounded-md text-[var(--text3)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}

      {showTimer && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left"
          style={{
            background: v.color,
            animation: `nf-timer ${toast.duration}ms linear forwards`,
            animationPlayState: paused ? "paused" : "running",
          }}
        />
      )}
    </div>
  );
}
