// Per-identity graph colour, edited from Settings → Identities. Writes the
// user's colour override for an email (`ui.identityColors`), which the graph
// node, node hover card, and commit trailer rows all read through
// `identityColor(email, overrides)`. Scoped to the user's own identity cards —
// arbitrary co-authors keep the deterministic hash colour.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { identityColor, IDENTITY_COLORS } from "@/lib/identityColor";
import { useUi } from "@/store/ui";
import { useFixedPopover } from "@/features/changes/useFixedPopover";

export function GraphColorPicker({ email }: { email: string }) {
  const overrides = useUi((s) => s.identityColors);
  const setIdentityColor = useUi((s) => s.setIdentityColor);
  const { ref, menuRef, open, menuStyle, toggle, close, portal } = useFixedPopover({
    align: "right",
    placement: "down",
  });

  const key = email.trim().toLowerCase();
  const color = identityColor(email, overrides);
  const hasOverride = Boolean(overrides[key]);
  const isPreset = IDENTITY_COLORS.some((swatch) => swatch.toLowerCase() === color.toLowerCase());

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title="Graph colour"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-2 text-[12px] font-medium text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
          focusRing,
        )}
      >
        <span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ background: color }} />
        Colour
      </button>

      {portal(() => (
        <div
          ref={menuRef}
          // Above the Settings modal (z-[80]); it portals into `.gp-root`
          // alongside the modal, so a lower z-index would hide it behind it.
          style={menuStyle}
          // The popover lives outside the Settings dialog's DOM subtree (it's
          // portaled to `.gp-root`), so the modal's outside-mousedown dismissal
          // would treat a swatch click as "outside" and close the whole modal
          // before the click lands. Stop the mousedown here so it never reaches
          // that document-level listener; `click` still fires on the swatches.
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-[90] w-[204px] rounded-xl border border-black/10 bg-white p-2.5 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.28)] dark:border-white/10 dark:bg-neutral-900"
        >
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            Graph colour
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {IDENTITY_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Use ${swatch}`}
                aria-pressed={color.toLowerCase() === swatch.toLowerCase()}
                onClick={() => setIdentityColor(email, swatch)}
                className={cn(
                  "h-5 w-5 rounded-full ring-offset-1 ring-offset-white transition-transform hover:scale-110 dark:ring-offset-neutral-900",
                  color.toLowerCase() === swatch.toLowerCase() && "ring-2 ring-neutral-400",
                )}
                style={{ background: swatch }}
              />
            ))}
            <label
              className={cn(
                "relative grid h-5 w-5 cursor-pointer place-items-center overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/15",
                hasOverride && !isPreset && "ring-2 ring-neutral-400",
              )}
              style={{
                background: hasOverride && !isPreset ? color : undefined,
                backgroundImage:
                  hasOverride && !isPreset
                    ? undefined
                    : "conic-gradient(#ef4444,#eab308,#22c55e,#3b82f6,#a855f7,#ef4444)",
              }}
              title="Custom colour"
            >
              <input
                type="color"
                aria-label="Custom colour"
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#3b7ff5"}
                onChange={(event) => setIdentityColor(email, event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          </div>
          {hasOverride && (
            <button
              type="button"
              onClick={() => {
                setIdentityColor(email, null);
                close();
              }}
              className="mt-2.5 text-[11px] text-neutral-400 hover:text-neutral-600 hover:underline dark:hover:text-neutral-200"
            >
              Reset to default
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
