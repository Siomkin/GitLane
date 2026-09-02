// Pure parser for a provider-supplied unified-diff fragment on a review thread.
// Returns nothing when the fragment is missing or not a hunk, so the card can
// omit the snippet instead of painting garbage. Not a file-diff engine.

export type SnippetKind = "header" | "add" | "del" | "ctx";

export interface SnippetLine {
  kind: SnippetKind;
  text: string;
}

export function parseThreadDiffSnippet(hunk: string | null | undefined): SnippetLine[] {
  if (hunk == null || hunk === "") return [];
  const normalized = hunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) return [];

  const lines: SnippetLine[] = [];
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      lines.push({ kind: "header", text: line });
      continue;
    }
    if (line.startsWith("\\")) continue;
    const prefix = line[0];
    if (prefix === "+" || prefix === "-" || prefix === " ") {
      lines.push({
        kind: prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx",
        text: line.slice(1),
      });
      continue;
    }
    return [];
  }
  return lines;
}
