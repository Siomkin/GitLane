import type { Token } from "./conflictModel";

/** Renders one code line's tokenized content (the colored spans). The caller
 * owns the row grid + line-number gutter; this is just the text column. */
export const Tokens = ({ tokens }: { tokens: Token[] }) => (
  <span className="whitespace-pre pl-2 pr-4">
    {tokens.map((t, i) => (
      <span key={i} className={t.cls}>
        {t.v}
      </span>
    ))}
  </span>
);
