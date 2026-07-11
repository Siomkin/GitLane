/**
 * Read a versioned localStorage value and consume its unversioned predecessor.
 * A readable legacy value is still returned when quota/storage policy prevents
 * the best-effort copy; when the versioned value exists it always wins.
 */
export function readMigratedStorage(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) {
    try {
      localStorage.removeItem(legacyKey);
    } catch {
      // Stale cleanup is best-effort; the versioned value remains authoritative.
    }
    return current;
  }

  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;
  try {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
  } catch {
    // A quota/storage failure must not hide readable legacy data.
  }
  return legacy;
}
