import { Fragment } from "react";

/** Below this query length we don't mark substrings — 1–2 chars occur so often
 * that highlighting is noise rather than signal (matches the search UX request:
 * only highlight the found text once more than two characters are typed). */
const MIN_QUERY_LEN = 3;

/**
 * Render `text`, wrapping each case-insensitive occurrence of `query` in an
 * accent-tinted `<mark>` so the matched fragment stands out inside an already
 * highlighted (full-strength) row. Returns the text unchanged when the query is
 * shorter than {@link MIN_QUERY_LEN} or doesn't occur, so it's a safe drop-in
 * anywhere a plain string was rendered (the concatenated segments equal `text`,
 * keeping truncation/tooltip measurement intact).
 */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_QUERY_LEN) return <>{text}</>;

  const hay = text.toLowerCase();
  const segments: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, cursor)) {
    if (i > cursor) segments.push({ text: text.slice(cursor, i), hit: false });
    segments.push({ text: text.slice(i, i + needle.length), hit: true });
    cursor = i + needle.length;
  }
  if (segments.length === 0) return <>{text}</>;
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });

  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded-[2px] bg-[color:var(--accent)]/25 text-inherit">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
