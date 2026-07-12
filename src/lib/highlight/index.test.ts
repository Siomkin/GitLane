import { describe, expect, it } from "vitest";
import { highlight, Language, languageForPath } from "./index";

// The one invariant that matters (GL-195): the tokenizer must be LOSSLESS.
// index.ts documents a prior regression where `\` matched no group and was
// silently dropped from rendered lines — these tests make that class of regex
// edit fail loudly. Colors are asserted only as representative classifications
// (same-class tokens share a color), never as literal hexes.

const rendered = (text: string, dark = true, lang: Language = Language.Generic) =>
  highlight(text, dark, lang)
    .map((t) => t.text)
    .join("");

const colorOf = (text: string, token: string, dark = true, lang: Language = Language.Generic) => {
  // Fail loudly on a missing token — an undefined-vs-undefined comparison
  // would let relational assertions pass vacuously.
  const found = highlight(text, dark, lang).find((t) => t.text === token);
  if (!found) throw new Error(`token ${JSON.stringify(token)} not produced for ${JSON.stringify(text)}`);
  return found.color;
};

describe("highlight — lossless invariant", () => {
  const cases: [string, string][] = [
    ["plain code", "const x = fn(y) + 1;"],
    ["punctuation soup", "(){}[];:,.<>=!+-*/%&|^?~@"],
    ["backslashes", "path\\to\\file \\ end"],
    ["the prior regression shape", 'invoke("cmd\\n") \\'],
    ["unicode text", "héllo wörld — 日本語 → Ω≈ç√"],
    ["emoji and symbols", "🚀 deploy § ± ° · #hash"],
    ["comments", "let a = 1; // trailing note // twice"],
    ["strings with escapes", `msg = "a \\"quoted\\" part" + 'it\\'s' + \`tpl \${x}\``],
    ["numbers", "0xFF + 1_000.5 - 42"],
    ["mixed rust-ish", "pub fn run(&mut self) -> Result<(), Error> { self.0 += 1 }"],
    ["tabs and spaces", "\tindent  spaced\t\tend"],
    ["lone unmatched chars (NUL + JS line separators)", "\u0000\u2028\u2029"],
  ];

  for (const [label, input] of cases) {
    it(`reproduces every character: ${label}`, () => {
      expect(rendered(input, true)).toBe(input);
      expect(rendered(input, false)).toBe(input);
    });
  }

  // Losslessness must hold for every language's regex, including ones whose
  // comment group is the never-matching `(?!)` (JSON) and ones with `#`
  // comments and block comments.
  for (const lang of Object.values(Language)) {
    it(`stays lossless for language: ${lang}`, () => {
      const input = "# x\n// y\n/* z */\nkey = \"v\" + 42 // t\npath\\to\\x";
      expect(rendered(input, true, lang)).toBe(input);
      expect(rendered(input, false, lang)).toBe(input);
    });
  }

  it("returns no tokens for empty input", () => {
    expect(highlight("", true)).toEqual([]);
  });
});

describe("highlight — representative classification", () => {
  it("groups keywords together and apart from identifiers", () => {
    const src = "const value = returnable";
    expect(colorOf(src, "const")).toBe(colorOf("if (x) return y", "return"));
    expect(colorOf(src, "const")).not.toBe(colorOf(src, "value"));
  });

  it("colors a call name only when the paren follows immediately", () => {
    const call = colorOf("doThing(1)", "doThing");
    expect(call).toBe(colorOf("other(2)", "other"));
    expect(call).not.toBe(colorOf("doThing + 1", "doThing"));
    expect(colorOf("doThing (1)", "doThing")).not.toBe(call);

    const type = colorOf("let x: MyType = y", "MyType");
    expect(type).not.toBe(colorOf("let x: MyType = y", "y"));
  });

  it("keeps keyword, type, and call-name classes pairwise distinct", () => {
    const src = "const MyType = baz()";
    const kw = colorOf(src, "const");
    const ty = colorOf(src, "MyType");
    const fn = colorOf(src, "baz");
    expect(new Set([kw, ty, fn]).size).toBe(3);
  });

  for (const dark of [true, false]) {
    it(`classifies comments, strings, and numbers distinctly (${dark ? "dark" : "light"})`, () => {
      const src = '// note\n"text" + 42';
      const [comment] = highlight("// note", dark);
      const string = colorOf(src, '"text"', dark);
      const number = colorOf(src, "42", dark);
      expect(new Set([comment.color, string, number]).size).toBe(3);
    });
  }

  it("keeps token text identical across dark and light palettes", () => {
    const src = "const s = \"x\"; // done";
    expect(highlight(src, true).map((t) => t.text)).toEqual(highlight(src, false).map((t) => t.text));
  });
});

describe("highlight — per language", () => {
  it("treats `#` as a comment in shell but not in generic", () => {
    const line = "echo hi # note";
    // In shell, everything from `#` to EOL is one comment token, colored like
    // a `//` comment is in a generic line.
    const shellComment = highlight(line, true, Language.Shell).find((t) => t.text === "# note");
    expect(shellComment?.color).toBe(highlight("// x", true)[0].color);
    // Generic has no `#` comment — the `#` is punctuation, "note" a separate token.
    expect(highlight(line, true).some((t) => t.text === "# note")).toBe(false);
  });

  it("colors a single-line block comment for languages that define one", () => {
    const line = "a /* mid */ b";
    const block = highlight(line, true, Language.Ts).find((t) => t.text === "/* mid */");
    expect(block).toBeDefined();
    // Generic (diff) tokenizer has no block comment — it stays punctuation/text.
    expect(highlight(line, true).some((t) => t.text === "/* mid */")).toBe(false);
  });

  it("highlights JSON literals as keywords and keeps `#` literal (no comment)", () => {
    const kw = colorOf('{"a": true}', "true", true, Language.Json);
    expect(kw).toBe(colorOf("[false]", "false", true, Language.Json));
    // JSON has no comment syntax — a stray `#` must not swallow the rest.
    expect(rendered('{"x": "#y"}', true, Language.Json)).toBe('{"x": "#y"}');
  });

  it("classifies Rust keywords that are not JS keywords", () => {
    const kw = colorOf("let x = 1", "let", true, Language.Rust);
    expect(colorOf("mod m {}", "mod", true, Language.Rust)).toBe(kw);
    expect(colorOf("impl T {}", "impl", true, Language.Rust)).toBe(kw);
  });
});

describe("languageForPath", () => {
  const cases: [string, Language][] = [
    ["src/App.tsx", Language.Ts],
    ["lib/api/git.ts", Language.Ts],
    ["src-tauri/src/lib.rs", Language.Rust],
    ["package.json", Language.Json],
    ["Cargo.toml", Language.Toml],
    ["src/App.css", Language.Css],
    ["scripts/build.sh", Language.Shell],
    ["Dockerfile", Language.Shell],
    [".github/workflows/ci.yml", Language.Yaml],
    ["README.md", Language.Markdown],
    ["LICENSE", Language.Generic],
    ["noext", Language.Generic],
    ["weird.unknownext", Language.Generic],
  ];
  for (const [path, lang] of cases) {
    it(`maps ${path} → ${lang}`, () => {
      expect(languageForPath(path)).toBe(lang);
    });
  }
});
