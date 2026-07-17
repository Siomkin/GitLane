// The persisted Zustand store (store/ui) writes to localStorage on every
// setState. Install a deterministic in-memory implementation without first
// reading `globalThis.localStorage`: recent Node versions expose that name
// through an experimental getter which warns (and may throw) unless Node was
// started with `--localstorage-file`.
export function installLocalStorage() {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mem,
    configurable: true,
    writable: true,
  });
}
