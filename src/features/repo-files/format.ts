/** Human-readable byte size for the file viewer header / notices. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 byte length of a string — what the backend's byte cap measures, so the
 * truncation notice reports bytes, not UTF-16 code units. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Split `text` into at most `cap` lines and report the true total line count,
 * without materializing every line of a huge (short-lined) file. Only the head
 * that will actually render is allocated as strings; the rest is counted by
 * scanning for newlines. */
export function splitLinesCapped(text: string, cap: number): { lines: string[]; total: number } {
  let total = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) total++;
  if (total <= cap) return { lines: text.split("\n"), total };

  const lines: string[] = [];
  let start = 0;
  for (let n = 0; n < cap; n++) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, nl));
    start = nl + 1;
  }
  return { lines, total };
}
