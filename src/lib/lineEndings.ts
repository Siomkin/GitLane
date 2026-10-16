// Line-ending style of a text file, so the in-app editor (a <textarea>, which
// always hands back LF) can write a CRLF file back with its CRLF intact.

/** `lf`: no CR at all. `crlf`: every line break is CR LF. `mixed`: anything
 * else (both styles, or a lone CR) — no single style round-trips it. */
export type LineEnding = "lf" | "crlf" | "mixed";

export function lineEndingOf(text: string): LineEnding {
  if (!text.includes("\r")) return "lf";
  const crlf = text.split("\r\n").length - 1;
  const cr = text.split("\r").length - 1;
  const lf = text.split("\n").length - 1;
  return crlf === cr && crlf === lf ? "crlf" : "mixed";
}

/** The text as the editor holds it: CR LF line breaks become LF. */
export const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

/** Write LF text back in the given style (`mixed` files are never edited). */
export const withLineEnding = (text: string, ending: LineEnding): string =>
  ending === "crlf" ? toLf(text).replace(/\n/g, "\r\n") : text;
