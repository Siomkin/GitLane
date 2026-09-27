import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = 1_700_000_000;
const at = (secondsAgo: number) => NOW - secondsAgo;
const opts = { now: NOW * 1000 };

describe("relativeTime", () => {
  it("returns empty for a missing timestamp and 'just now' under a minute or in the future", () => {
    expect(relativeTime(0, opts)).toBe("");
    expect(relativeTime(at(59), opts)).toBe("just now");
    expect(relativeTime(NOW + 100, opts)).toBe("just now");
  });

  it("formats compact ages with one set of unit boundaries", () => {
    expect(relativeTime(at(5 * 60), opts)).toBe("5m ago");
    expect(relativeTime(at(3 * 3600), opts)).toBe("3h ago");
    expect(relativeTime(at(2 * 86400), opts)).toBe("2d ago");
    expect(relativeTime(at(60 * 86400), opts)).toBe("2mo ago");
    expect(relativeTime(at(800 * 86400), opts)).toBe("2y ago");
  });

  it("spells the same age out in the long format, pluralizing all but one", () => {
    expect(relativeTime(at(60), { ...opts, long: true })).toBe("1 minute ago");
    expect(relativeTime(at(2 * 86400), { ...opts, long: true })).toBe("2 days ago");
    expect(relativeTime(at(30 * 86400), { ...opts, long: true })).toBe("1 month ago");
    // Same boundary as the compact form: 60 days is 2 months in both.
    expect(relativeTime(at(60 * 86400), { ...opts, long: true })).toBe("2 months ago");
  });
});
