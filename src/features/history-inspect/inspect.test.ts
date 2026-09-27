import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANE_COLORS } from "@/features/graph/palette";
import { oidColor, shortAge } from "./inspect";

// Pin "now" so the boundary math is deterministic (GL-193).
const NOW_SECONDS = 1_700_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

const at = (secondsAgo: number) => NOW_SECONDS - secondsAgo;

describe("shortAge", () => {
  it("returns empty for a missing timestamp and 'now' under a minute", () => {
    expect(shortAge(0)).toBe("");
    expect(shortAge(at(30))).toBe("now");
  });

  it("uses the largest unit that fits, switching exactly at the boundaries", () => {
    expect(shortAge(at(59))).toBe("now");
    expect(shortAge(at(60))).toBe("1m");
    expect(shortAge(at(3600))).toBe("1h");
    expect(shortAge(at(90))).toBe("1m");
    expect(shortAge(at(7200))).toBe("2h");
    expect(shortAge(at(3 * 86400))).toBe("3d");
    expect(shortAge(at(2 * 604800))).toBe("2wk");
    expect(shortAge(at(3 * 2629800))).toBe("3mo");
    expect(shortAge(at(2 * 31557600))).toBe("2y");
  });
});

describe("oidColor", () => {
  it("is deterministic and always a lane color", () => {
    const color = oidColor("abcdef1234567890");
    expect(oidColor("abcdef1234567890")).toBe(color);
    expect(LANE_COLORS).toContain(color);
    // Different oids can collide, but the empty oid must still resolve.
    expect(LANE_COLORS).toContain(oidColor(""));
  });
});
