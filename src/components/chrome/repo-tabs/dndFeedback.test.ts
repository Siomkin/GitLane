// `dndFeedback.css` is a hand copy of the sheet @dnd-kit/dom injects, which the
// app's CSP blocks. If a dnd-kit upgrade renames an attribute or a `--dnd-*`
// property that sheet reads, the copy silently stops matching and dragged tabs
// land in the window's top-left corner again — so read the names off the
// installed library and require each one in the copy.
//
// What this can't see — a drag that *looks* wrong with the right names — has
// no unit test: dnd-kit can't run a drag under happy-dom or jsdom (no
// `document.getAnimations`, no popover). It is checked by hand: in the browser
// pane with dnd-kit's own sheet disabled, and in the app on macOS and Linux
// (openspec change fix-repo-tab-drag, tasks 1.3 and 4.x).

import { describe, expect, it } from "vitest";
import dndDom from "@dnd-kit/dom?raw";
// Read as text only because vitest.config.ts exempts this file from its CSS stub.
import css from "./dndFeedback.css?raw";

/** dnd-kit's injected `CSS_RULES` with its `${CONSTANT}` interpolations resolved. */
function injectedRules(source: string): string {
  const constants = new Map<string, string>();
  for (const [, name, value] of source.matchAll(/^var (\w+) = "([^"]*)";$/gm)) {
    constants.set(name, value);
  }
  for (const [, name, prefix, rest] of source.matchAll(/^var (\w+) = `\$\{(\w+)\}([\w-]*)`;$/gm)) {
    constants.set(name, `${constants.get(prefix) ?? ""}${rest}`);
  }
  const start = source.indexOf("var CSS_RULES = `");
  if (start === -1) throw new Error("@dnd-kit/dom no longer declares CSS_RULES; recheck dndFeedback.css");
  const body = source.slice(start, source.indexOf("`.replace", start));
  return body.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const value = constants.get(name);
    if (value === undefined) throw new Error(`unresolved \${${name}} in dnd-kit's CSS_RULES`);
    return value;
  });
}

const rules = injectedRules(dndDom);
const names = (pattern: RegExp) => [...new Set([...rules.matchAll(pattern)].map((m) => m[1]))];

describe("dndFeedback.css matches the sheet @dnd-kit/dom injects", () => {
  const attributes = names(/\[(data-dnd-[\w-]+)/g);
  const properties = names(/(--dnd-[\w-]+)/g);

  it("found what dnd-kit's sheet reads", () => {
    expect(attributes).toEqual(
      expect.arrayContaining(["data-dnd-dragging", "data-dnd-placeholder", "data-dnd-dropping"]),
    );
    expect(properties).toEqual(expect.arrayContaining(["--dnd-top", "--dnd-left", "--dnd-translate"]));
  });

  it.each(attributes)("styles the %s attribute", (attribute) => {
    expect(css).toContain(`[${attribute}`);
  });

  it.each(properties)("reads the %s property", (property) => {
    expect(css).toContain(property);
  });
});
