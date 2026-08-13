import {
  useLayoutEffect,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
  type RefObject,
} from "react";
import { useUi } from "@/store/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { isMac } from "@/lib/platform";
import { shortcutParts, type ShortcutId } from "@/lib/shortcuts";
import { focusRing } from "@/lib/ui";
import { ChevronRightIcon } from "@/components/ui/icons";
import { ShortcutHint } from "@/components/ui/ShortcutHint";

/**
 * Keep a menu anchored at (x, y) fully on-screen. Measures the panel's *real*
 * rendered size in a layout effect (before paint, so there's no flicker), then:
 *   - slides it left when it would overflow the right edge,
 *   - slides it up when it would overflow the bottom edge,
 *   - and, only when it's taller than the viewport, pins it to the top and caps
 *     its height so it scrolls internally instead of running off-screen.
 *
 * This replaces the old per-menu `window.innerHeight - <hardcoded guess>` clamps,
 * which cut tall menus (e.g. the branch context menu) off at the bottom.
 */
export function useFittedMenuPosition(
  x: number,
  y: number,
  ref: RefObject<HTMLElement | null>,
  deps: DependencyList = [],
) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number }>({
    left: x,
    top: y,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.scrollHeight; // natural content height, ignoring any max-height cap
    const maxHeight = vh - margin * 2;
    const left = Math.max(margin, Math.min(x, vw - margin - w));
    const top = h <= maxHeight ? Math.max(margin, Math.min(y, vh - margin - h)) : margin;
    setPos({ left, top, maxHeight });
    // ref is stable; x/y + caller-supplied deps drive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...deps]);
  return pos;
}

/** Run a branch operation, surfacing only git errors as a toast. Routine success
 * (checkout, rebase, merge, …) is silent — the graph/navigator already update.
 * Empty result means the op handed off to its own surface (e.g. a blocked
 * checkout raising the reclaim dialog). */
export function useBranchOp() {
  const showToast = useUi((s) => s.showToast);
  return async (op: () => Promise<string>) => {
    try {
      await op();
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e), "error");
    }
  };
}
export interface MenuItem {
  label: string;
  /** Required unless `header` or `submenu` is set. */
  onClick?: () => void;
  /** Leading glyph — the caller sizes it (e.g. `<PushIcon className="h-4 w-4" />`). */
  icon?: ReactNode;
  /** Accordion children: the row becomes an in-place expander. One level only. */
  submenu?: MenuItem[];
  /** Faint mono context line shown atop an expanded submenu (e.g. "into main"). */
  note?: string;
  /** Two spellings of destructive, and the rule between them (GL-359): a leaf
   * row that *performs* a destructive action is `danger` (rose text, always);
   * an expander whose children are destructive is `tone: "danger"` (neutral
   * until hovered, so a whole group doesn't shout before it is opened). Never
   * both, and never `tone` on a leaf. */
  tone?: "danger";
  /** Visible but non-interactive item, usually paired with a short reason. */
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  /** Non-clickable group header (e.g. a label above a cluster of related
   * actions like the reset-mode choices). Renders muted, no hover state. */
  header?: boolean;
  /** Trailing key-cap hint from the shortcut registry. Hidden from the
   *  accessible name; rendered the way this platform writes the binding. */
  shortcut?: ShortcutId;
}

/** A thin divider row between menu items — state-free. */
const sep = (key: string) => (
  <div key={key} className="my-1 mx-2 h-px bg-black/5 dark:bg-white/5" />
);

export function MenuPanel({
  left,
  top,
  groups,
  onClose,
  width = 220,
  heading,
}: {
  /** Anchor x (e.g. the click's clientX) — clamped on-screen internally. */
  left: number;
  /** Anchor y (e.g. the click's clientY) — clamped on-screen internally. */
  top: number;
  /**
   * Rows in groups. The panel draws a divider between consecutive non-empty
   * groups and nothing else — a menu declares *what belongs together*, never
   * where a line goes (GL-359). Empty groups are skipped, so a caller can build
   * a section conditionally without also computing whether it now owns the
   * boundary; that computation was previously done two different ways, one of
   * which rewrote the first element of an array to carry the flag.
   */
  groups: MenuItem[][];
  onClose: () => void;
  width?: number;
  /** Optional non-interactive header block rendered at the top of the panel. */
  heading?: ReactNode;
}) {
  const sections = groups.filter((rows) => rows.length > 0);
  // Close on Escape (and outside mousedown); the backdrop shields underlying
  // content from the dismissing click. Mirrors ConfirmDialog/the navigator.
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, panelRef);
  // Single-open accordion: key of the expanded submenu row (or null). Opening
  // one collapses the others so the panel stays compact. The key spans groups —
  // a per-group index would collide, expanding one group's first row alongside
  // another's.
  const [openIndex, setOpenIndex] = useState<string | null>(null);
  // openIndex changes the panel height, so re-fit on toggle as well as count.
  // Count rows, not sections: a row appearing inside an already non-empty group
  // (a deferred verb resolving, a background re-sync) changes the height without
  // changing the section count, and would otherwise keep a stale clamp.
  const rowCount = sections.reduce((n, rows) => n + rows.length, 0);
  const pos = useFittedMenuPosition(left, top, panelRef, [rowCount, sections.length, openIndex]);

  // A leaf row (also used for submenu children, with `nested` adding indent).
  const renderRow = (it: MenuItem, key: string, nested: boolean) => {
    if (it.header) {
      return (
        <div key={key}>
          <div
            className={`flex items-center gap-1.5 pb-1 pt-1.5 ${
              nested ? "pl-9 pr-3" : "px-3"
            } ${it.danger || it.tone === "danger" ? "text-rose-500/70" : "text-neutral-400"}`}
          >
            {it.icon && <span className="grid shrink-0 place-items-center">{it.icon}</span>}
            <span className="text-[10px] font-semibold uppercase tracking-wider">{it.label}</span>
          </div>
        </div>
      );
    }
    const reasonId = it.disabledReason ? `menu-item-reason-${key}` : undefined;
    const pad = nested ? "pl-9 pr-3" : "px-3";
    return (
      <div key={key}>
        <button
          type="button"
          role="menuitem"
          disabled={it.disabled}
          aria-label={it.disabledReason ? it.label : undefined}
          aria-describedby={reasonId}
          onClick={it.disabled ? undefined : it.onClick}
          className={`flex w-full items-center gap-2.5 text-left text-[13px] ${focusRing} ${
            it.disabledReason ? "min-h-10 py-1.5" : "h-8"
          } ${pad} ${
            it.disabled
              ? "cursor-not-allowed text-neutral-400 dark:text-neutral-500"
              : it.danger
              ? "text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
              : it.tone === "danger"
              ? "group text-neutral-700 hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-200 dark:hover:text-rose-400"
              : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          }`}
        >
          {/* Reserve the icon column on top-level rows so their labels align down
              one edge whether or not a row has a glyph. Nested submenu children are
              already indented as a group, so they keep the tighter padding and only
              render a slot when they actually carry an icon. */}
          {(!nested || it.icon) && (
            <span
              className={`grid h-4 w-4 shrink-0 place-items-center ${
                it.danger
                  ? ""
                  : it.tone === "danger"
                    ? "text-neutral-400 group-hover:text-rose-500"
                    : "text-neutral-400"
              }`}
            >
              {it.icon}
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="whitespace-nowrap">{it.label}</span>
            {it.disabledReason && (
              <span id={reasonId} className="mt-0.5 whitespace-normal text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
                {it.disabledReason}
              </span>
            )}
          </span>
          {it.shortcut && <ShortcutHint keys={shortcutParts(it.shortcut, isMac)} />}
        </button>
      </div>
    );
  };

  // `key` is `${group}-${row}` — unique across the whole panel, so it doubles as
  // the accordion's identity and as the `reasonId` suffix a row index alone
  // could collide on.
  const renderItem = (it: MenuItem, key: string) => {
    if (!it.submenu) return renderRow(it, key, false);
    const open = openIndex === key;
    const danger = it.tone === "danger";
    return (
      <div key={key}>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpenIndex(open ? null : key)}
          className={`group flex h-8 w-full items-center gap-2.5 px-3 text-left text-[13px] ${focusRing} ${
            danger
              ? "text-neutral-700 hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-200 dark:hover:text-rose-400"
              : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          }`}
        >
          {/* Same reserved icon column as leaf rows, so a submenu expander's
              label lines up with the leaf labels above and below it. */}
          <span className={`grid h-4 w-4 shrink-0 place-items-center text-neutral-400 ${danger ? "group-hover:text-rose-500" : ""}`}>
            {it.icon}
          </span>
          <span className="whitespace-nowrap">{it.label}</span>
          <ChevronRightIcon
            className={`ml-auto -mr-1 h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${
              open ? "rotate-90" : ""
            } ${danger ? "group-hover:text-rose-500" : ""}`}
          />
        </button>
        {open && (
          <div className="border-y border-black/5 bg-black/[0.025] dark:border-white/5 dark:bg-white/[0.03]">
            {/* Danger groups carry their meaning via the rose header/items, not a
                background wash — keep the expanded tint neutral like every group. */}
            {it.note && (
              <div className="truncate px-3 pb-0.5 pl-9 pt-1.5 font-mono text-[10.5px] text-neutral-400">
                {it.note}
              </div>
            )}
            {it.submenu.map((child, ci) => renderRow(child, `${key}-${ci}`, true))}
            <div className="h-1" />
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <Backdrop onClick={onClose} z={49} />
      <div
        ref={panelRef}
        role="menu"
        className="fixed z-50 overflow-y-auto rounded-xl border border-black/10 bg-white py-1.5 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        style={{
          left: pos.left,
          top: pos.top,
          minWidth: width,
          maxHeight: pos.maxHeight,
          animation: "gp-pop .12s ease-out",
        }}
      >
        {heading && (
          <div className="mb-1 border-b border-black/5 px-3 pb-1.5 pt-0.5 dark:border-white/5">{heading}</div>
        )}
        {sections.map((rows, g) => (
          <div key={g}>
            {g > 0 && sep(`group-${g}`)}
            {rows.map((it, i) => renderItem(it, `${g}-${i}`))}
          </div>
        ))}
      </div>
    </>
  );
}
export function Backdrop({ onClick, z }: { onClick: () => void; z: number }) {
  return <div className="fixed inset-0" style={{ zIndex: z }} onClick={onClick} />;
}
