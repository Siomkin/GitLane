import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SuggestItem {
  /** Handed to `onPick` when chosen. */
  value: string;
  /** Main row text; defaults to `value`. */
  label?: string;
  /** Dimmed right-side annotation (an email, "remote", "tag", …). */
  hint?: string;
}

/** Pull a highlight index back inside a list that may have shrunk. Kept in one
 * place so the render-time derivation, the normalization effect, and the arrow
 * stepper can't drift apart. `-1` (no highlight) is preserved. */
const clampToList = (index: number, length: number) => (index >= length ? length - 1 : index);

/**
 * A text input with a lightweight suggestion dropdown. Domain-free: the
 * parent computes `items` for the current value (sync or async) and decides
 * in `onPick` how a chosen value lands in the field — e.g. replacing only
 * the token after `..` in a revision range. Keyboard: arrows move, Enter
 * picks (only while an item is active, so plain Enter still submits the
 * form), Escape closes.
 */
export function SuggestInput({
  value,
  onChange,
  onPick,
  items,
  placeholder,
  className,
  ariaLabel,
  hintPlacement = "end",
}: {
  value: string;
  onChange: (value: string) => void;
  onPick: (value: string) => void;
  items: SuggestItem[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  /** `"end"` (default) right-aligns the hint (good for short kind tags like
   * "branch"/"tag"); `"inline"` renders it right after the label so a longer
   * hint (e.g. an email) stays visible instead of truncating off the edge. */
  hintPlacement?: "end" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Stable ids so the input can point `aria-controls` at the listbox and
  // `aria-activedescendant` at the highlighted option (WAI-ARIA combobox).
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  // Clamp the highlight to the current list. `safeActive` is derived during
  // render so `aria-activedescendant` / `aria-selected` / the highlight never
  // point at an option id that isn't rendered on the same frame (a post-paint
  // effect alone leaves a one-frame gap).
  const safeActive = clampToList(active, items.length);

  // …and the effect keeps the raw state in range too, so a stale out-of-range
  // index can't resurface if the list shrinks and later regrows without user
  // input (e.g. async suggestion refresh while a row is arrow-highlighted).
  useEffect(() => {
    setActive((current) => clampToList(current, items.length));
  }, [items.length]);

  const showList = open && items.length > 0;

  // Whether a list has been on screen since the field was opened. Escape has to
  // swallow for as long as the field is acting as a picker, and `showList` alone
  // is false in the state a user reaches most easily: a filter that matches
  // nothing. Escaping out of that typo would otherwise reach the dialog behind
  // and throw the whole form away.
  const wasListShown = useRef(false);
  if (showList) wasListShown.current = true;

  const dismiss = () => {
    setOpen(false);
    setActive(-1);
    wasListShown.current = false;
  };

  const pick = (item: SuggestItem) => {
    onPick(item.value);
    dismiss();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      const down = event.key === "ArrowDown";
      if (!open) setOpen(true);
      // From no active row (just opened, or open-but-unhighlighted) ArrowDown
      // lands on the first item and ArrowUp on the last; from an active row it
      // wraps by one. (A plain modulo step from -1 would skip to n-2 on ArrowUp.)
      // Clamp first so a stale index left over from a larger list steps sanely.
      setActive((current) => {
        const cur = clampToList(current, items.length);
        return cur < 0 ? (down ? 0 : items.length - 1) : (cur + (down ? 1 : -1) + items.length) % items.length;
      });
      return;
    } else if (event.key === "Enter") {
      if (showList && safeActive >= 0 && items[safeActive]) {
        event.preventDefault();
        pick(items[safeActive]);
      }
    } else if (event.key === "Escape" || event.key === "Tab") {
      // Escape closes the list and stops there: inside a dialog the same key
      // dismisses the whole modal, and closing a dropdown should not throw the
      // form away with it. Once no list is up, a second Escape does reach the
      // dialog — cancelling a field the user never opened should not need two
      // presses. Tab still bubbles — it is navigating, not cancelling.
      if (event.key === "Escape" && (showList || wasListShown.current)) event.stopPropagation();
      dismiss();
    }
  };

  return (
    <div className="relative min-w-0">
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        // Picking keeps focus in the field (the row's mousedown preventDefault
        // beats the blur), so focus never leaves and clicking back in fires no
        // onFocus. Without this, the list can only be reopened by editing the
        // text — which is not how a picker behaves.
        onClick={() => setOpen(true)}
        onBlur={dismiss}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={showList ? listboxId : undefined}
        aria-activedescendant={showList && safeActive >= 0 ? optionId(safeActive) : undefined}
        aria-label={ariaLabel}
        className={className}
      />
      {showList && (
        <ul
          role="listbox"
          id={listboxId}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded-md border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-neutral-900"
        >
          {items.map((item, index) => (
            <li key={`${item.value}-${index}`} id={optionId(index)} role="option" aria-selected={index === safeActive}>
              <button
                type="button"
                tabIndex={-1}
                // mousedown, not click: picking must beat the input's blur
                // (which closes the list before a click could land).
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs",
                  index === safeActive
                    ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                    : "text-neutral-700 dark:text-neutral-200",
                )}
              >
                {hintPlacement === "inline" ? (
                  <span className="min-w-0 flex-1 truncate">
                    {item.label ?? item.value}
                    {item.hint && <span className="ml-2 text-neutral-400">{item.hint}</span>}
                  </span>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.label ?? item.value}</span>
                    {item.hint && (
                      <span className="max-w-32 shrink-0 truncate text-[10px] text-neutral-400">
                        {item.hint}
                      </span>
                    )}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
