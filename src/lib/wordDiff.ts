// Word-level difference between a removed line and the added line that replaces
// it: which character ranges on each side changed. Token-level LCS, where a
// token is a word, a whitespace run, or one punctuation character.

/** Half-open character range `[start, end)` within a line. */
export type CharRange = [number, number];

/** Above this many tokens on either side the O(n·m) table is not worth it. */
const MAX_TOKENS = 400;
const TOKEN = /\w+|\s+|[^\w\s]/g;

const tokenize = (text: string): string[] => text.match(TOKEN) ?? [];
const isSpace = (token: string) => /^\s+$/.test(token);

/** Changed ranges on the old (`a`) and new (`b`) line, or null when the pair is
 * too long to compare or shares no word (a rewrite, not an edit — highlighting
 * all of it would say nothing the line tint does not). */
export function wordDiff(a: string, b: string): { a: CharRange[]; b: CharRange[] } | null {
  if (a === b) return null;
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;

  // lcs[i][j] = LCS length of ta[i..] and tb[j..]
  const lcs: number[][] = Array.from({ length: ta.length + 1 }, () => new Array<number>(tb.length + 1).fill(0));
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      lcs[i][j] = ta[i] === tb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const keepA = new Array<boolean>(ta.length).fill(false);
  const keepB = new Array<boolean>(tb.length).fill(false);
  let sharedWord = false;
  for (let i = 0, j = 0; i < ta.length && j < tb.length; ) {
    if (ta[i] === tb[j]) {
      keepA[i] = keepB[j] = true;
      if (!isSpace(ta[i])) sharedWord = true;
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  if (!sharedWord) return null;
  return { a: changedRanges(ta, keepA), b: changedRanges(tb, keepB) };
}

/** Merge runs of unkept tokens into ranges, trimming whitespace at their edges. */
function changedRanges(tokens: string[], keep: boolean[]): CharRange[] {
  const ranges: CharRange[] = [];
  let offset = 0;
  let open: CharRange | null = null;
  tokens.forEach((token, i) => {
    const end = offset + token.length;
    if (!keep[i] && !(open === null && isSpace(token))) {
      if (open) open[1] = end;
      else open = [offset, end];
    } else if (open) {
      ranges.push(open);
      open = null;
    }
    offset = end;
  });
  if (open) ranges.push(open);
  return ranges.map(([start, end]) => {
    const text = tokens.join("").slice(start, end);
    return [start, end - (text.length - text.trimEnd().length)] as CharRange;
  });
}
