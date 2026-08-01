// A raw `<select>` gets the platform's own chrome from WebKitGTK — a light GTK
// widget with washed-out text inside our dark panels (see `Select.tsx`). Every
// select in the app must therefore go through `Select`, which strips it.
//
// One repo-wide guard instead of a class-string assertion per call site: this
// catches the next raw `<select>` wherever it lands, which is how both of the
// ones this replaced got in. Sources come from `import.meta.glob` rather than a
// `node:fs` walk so the check needs no `@types/node`.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The one file allowed to render a raw `<select>` — it *is* the wrapper.
 * `import.meta.glob` normalizes keys against this file, so it's a sibling. */
const WRAPPER = "./Select.tsx";
/** Skip backticked code spans, so a doc comment may still name the element. */
const RAW_SELECT = /(?<!`)<select[\s>]/;

describe("no raw <select> outside the Select wrapper", () => {
  it("routes every select through Select, so the native chrome stays stripped", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path, source]) => path !== WRAPPER && RAW_SELECT.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("still finds the wrapper itself, so the scan can't pass by matching nothing", () => {
    expect(SOURCES[WRAPPER]).toMatch(RAW_SELECT);
  });
});
