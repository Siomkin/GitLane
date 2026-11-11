/** One rendered line of a confirm dialog's impact panel. Previews send plain
 * strings (`push_list` in Rust): a `Label:` header, then its items — for file
 * lists a porcelain `XY path` line, ending with an optional `… and N more`. */
export type ImpactLine =
  | { kind: "head"; text: string; count: number }
  | { kind: "file"; status: string; path: string }
  | { kind: "more"; text: string }
  | { kind: "text"; text: string };

const FILE = /^([ MADRCUT?!]{2}) (.+)$/;
const MORE = /^… and (\d+) more$/;

/** Classify preview lines. File and "more" lines are recognised only inside a
 * `Label:` section so free text elsewhere is never misread as a status line. */
export function parseImpactLines(lines: readonly string[]): ImpactLine[] {
  const out: ImpactLine[] = [];
  let head: Extract<ImpactLine, { kind: "head" }> | null = null;
  for (const line of lines) {
    if (line.endsWith(":") && line.length > 1) {
      head = { kind: "head", text: line.slice(0, -1), count: 0 };
      out.push(head);
      continue;
    }
    const more = head && MORE.exec(line);
    if (head && more) {
      head.count += Number(more[1]);
      out.push({ kind: "more", text: line });
      continue;
    }
    const file = head && FILE.exec(line);
    if (head) head.count += 1;
    if (file) {
      const code = file[1];
      out.push({ kind: "file", status: code === "??" ? "U" : code.trim()[0], path: file[2] });
    } else {
      out.push({ kind: "text", text: line });
    }
  }
  return out;
}
