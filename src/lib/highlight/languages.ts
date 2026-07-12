// Per-language configuration for the lightweight tokenizer (GL-212). The engine
// stays a single-pass, per-line regex (fits the viewer's virtualized one-row-
// per-line render); languages differ only in their comment syntax and keyword
// set. TS/TSX/JS, Rust, and JSON are tuned to be genuinely good — they dominate
// this repo — while CSS/TOML/shell/YAML/Markdown are best-effort. Anything
// unrecognised falls back to `Language.Generic`, whose config reproduces the
// original diff tokenizer verbatim, so the diff highlighting is unchanged.

/** A tokenizer language key. Compare against `Language.Rust`, never a bare
 * `"rust"` literal, so a typo fails to compile (the RefKind/ForgeKind idiom). */
export const Language = {
  Generic: "generic",
  Ts: "ts",
  Rust: "rust",
  Json: "json",
  Toml: "toml",
  Css: "css",
  Shell: "shell",
  Yaml: "yaml",
  Markdown: "markdown",
} as const;
export type Language = (typeof Language)[keyof typeof Language];

/** How one language's comments and keywords vary. Strings (`` ` ``, `"`, `'`)
 * and numbers are handled uniformly by the engine and need no per-language
 * entry. Block comments are only recognised when they open *and* close on the
 * same line — a per-line pass can't carry state across rows. */
export interface LangConfig {
  /** Line-comment prefixes (e.g. `["//"]`, `["#"]`). */
  lineComment: string[];
  /** `[open, close]` for a single-line block comment (slash-star … star-slash). */
  blockComment?: [string, string];
  /** Words painted as keywords. */
  keywords: Set<string>;
}

const set = (words: string): Set<string> => new Set(words.split(/\s+/).filter(Boolean));

// The Generic keyword set is the original tokenizer's combined JS+Rust list,
// kept intact so diff lines (which pass no language) tokenize exactly as before.
const GENERIC_KEYWORDS = set(
  "const let var function return if else for while do new typeof instanceof " +
    "import from export default await async class extends implements interface " +
    "type enum public private protected readonly static void null undefined true " +
    "false this super case switch break continue try catch finally throw of in " +
    "as yield fn pub struct impl trait use mut match ref move where Self self",
);

const TS_KEYWORDS = set(
  "const let var function return if else for while do new typeof instanceof " +
    "import from export default await async class extends implements interface " +
    "type enum namespace declare public private protected readonly abstract static " +
    "get set void null undefined true false this super case switch break continue " +
    "try catch finally throw of in as yield keyof infer satisfies is delete",
);

const RUST_KEYWORDS = set(
  "as async await break const continue crate dyn else enum extern false fn for if " +
    "impl in let loop match mod move mut pub ref return self Self static struct super " +
    "trait true type unsafe use where while box union macro_rules",
);

const JSON_KEYWORDS = set("true false null");

const YAML_KEYWORDS = set("true false null yes no on off");

const CONFIGS: Record<Language, LangConfig> = {
  [Language.Generic]: { lineComment: ["//"], keywords: GENERIC_KEYWORDS },
  [Language.Ts]: { lineComment: ["//"], blockComment: ["/*", "*/"], keywords: TS_KEYWORDS },
  [Language.Rust]: { lineComment: ["//"], blockComment: ["/*", "*/"], keywords: RUST_KEYWORDS },
  [Language.Json]: { lineComment: [], keywords: JSON_KEYWORDS },
  [Language.Toml]: { lineComment: ["#"], keywords: set("true false") },
  [Language.Css]: { lineComment: [], blockComment: ["/*", "*/"], keywords: new Set() },
  [Language.Shell]: {
    lineComment: ["#"],
    keywords: set(
      "if then else elif fi for while do done case esac in function return export " +
        "local readonly declare set unset source echo cd exit test true false",
    ),
  },
  [Language.Yaml]: { lineComment: ["#"], keywords: YAML_KEYWORDS },
  [Language.Markdown]: { lineComment: [], keywords: new Set() },
};

/** The config for a language key (falls back to Generic for safety). */
export const configFor = (lang: Language): LangConfig => CONFIGS[lang] ?? CONFIGS[Language.Generic];

// Extension → language. Kept deliberately small: the languages that actually
// appear in this repo, plus the obvious neighbours. Everything else is Generic.
const BY_EXT: Record<string, Language> = {
  ts: Language.Ts,
  tsx: Language.Ts,
  mts: Language.Ts,
  cts: Language.Ts,
  js: Language.Ts,
  jsx: Language.Ts,
  mjs: Language.Ts,
  cjs: Language.Ts,
  rs: Language.Rust,
  json: Language.Json,
  jsonc: Language.Json,
  toml: Language.Toml,
  css: Language.Css,
  scss: Language.Css,
  less: Language.Css,
  sh: Language.Shell,
  bash: Language.Shell,
  zsh: Language.Shell,
  yml: Language.Yaml,
  yaml: Language.Yaml,
  md: Language.Markdown,
  markdown: Language.Markdown,
};

// A few languages are better keyed by filename than extension.
const BY_FILENAME: Record<string, Language> = {
  dockerfile: Language.Shell,
  makefile: Language.Shell,
  ".zshrc": Language.Shell,
  ".bashrc": Language.Shell,
  ".gitignore": Language.Generic,
};

/** Pick a tokenizer language for a repo-relative path from its extension /
 * filename. Unknown types map to `Language.Generic` (the original behaviour). */
export function languageForPath(path: string): Language {
  const base = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  const byName = BY_FILENAME[base];
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  return BY_EXT[ext] ?? Language.Generic;
}
