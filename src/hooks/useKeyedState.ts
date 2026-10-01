import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/** `useState` scoped to `key`: when `key` changes the value reads as `initial`
 * in that same render, with no reset effect and no stale frame (the pattern
 * architecture-rules-react.md §1 asks for instead of `useEffect(() => set(x), [key])`).
 * `initial` must be stable — a primitive or a module constant. */
export function useKeyedState<T>(key: unknown, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [slot, setSlot] = useState<{ key: unknown; value: T }>({ key, value: initial });
  const value = Object.is(slot.key, key) ? slot.value : initial;
  const set = useCallback(
    (next: SetStateAction<T>) =>
      setSlot((prev) => {
        const current = Object.is(prev.key, key) ? prev.value : initial;
        return { key, value: typeof next === "function" ? (next as (prev: T) => T)(current) : next };
      }),
    [key, initial],
  );
  return [value, set];
}
