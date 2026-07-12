import type { SelectHTMLAttributes } from "react";

import { cn } from "@/lib/cn";
import { ChevronDownIcon } from "./icons";

/** Native `<select>` with the platform's own chrome stripped (GL-215).
 *
 * Stripping it is load-bearing, not cosmetic. Left native, WebKitGTK — the Linux
 * webview — paints the control with the GTK theme's chrome and colours and
 * ignores our background, border and text colour, so a select styled
 * `bg-transparent` renders as a light widget with washed-out text inside a dark
 * dialog. `appearance: none` hands the styling back to us.
 *
 * Tailwind v4 emits *only* the unprefixed `appearance` (there is no
 * `-webkit-appearance` anywhere in its output), and that property needs
 * WebKit 15.4+, so the prefixed form is kept alongside it — otherwise the fix
 * silently no-ops on an older WebKitGTK and the widget comes back.
 *
 * The dropdown *list* is still drawn by the OS; that's expected and fine, which
 * is why `<option>` elements keep their own `dark:bg-*`.
 *
 * `className` styles the control (height, background, border, type); layout that
 * belongs to the row around it (`flex-1`, `w-full`, margins) goes on
 * `wrapperClassName`, since the chevron needs a positioned parent. Room for the
 * chevron (`pr-7`) is part of the base, so callers only set padding to override.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Classes for the positioned wrapper — layout only (`w-full`, `flex-1`, …). */
  wrapperClassName?: string;
}

const BASE =
  "appearance-none [-webkit-appearance:none] pr-7 outline-none disabled:opacity-40";

export function Select({ className, wrapperClassName, children, ...props }: SelectProps) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <select className={cn(BASE, className)} {...props}>
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
      />
    </div>
  );
}
