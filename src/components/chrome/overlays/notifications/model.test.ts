import { describe, expect, it } from "vitest";

import type { Notification } from "@/store/notifications";
import { withLeaving } from "./model";

const toast = (id: number): Notification => ({ id, kind: "info", title: `t${id}`, duration: null });
const order = (rows: ReturnType<typeof withLeaving>) => rows.map((r) => r.toast.id);

describe("withLeaving", () => {
  it("puts a closing card back at its position and marks it", () => {
    const rows = withLeaving([toast(1), toast(3)], [{ toast: toast(2), index: 1 }]);
    expect(order(rows)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.leaving)).toEqual([false, true, false]);
  });

  it("keeps order when cards close top to bottom", () => {
    // 1 closes at index 0, then 2 (now first) also at index 0.
    const rows = withLeaving(
      [toast(3)],
      [
        { toast: toast(1), index: 0 },
        { toast: toast(2), index: 0 },
      ],
    );
    expect(order(rows)).toEqual([1, 2, 3]);
  });

  it("keeps order when cards close bottom to top", () => {
    const rows = withLeaving(
      [toast(1)],
      [
        { toast: toast(3), index: 2 },
        { toast: toast(2), index: 1 },
      ],
    );
    expect(order(rows)).toEqual([1, 2, 3]);
  });

  it("clamps an index past the end of a shrunken stack", () => {
    expect(order(withLeaving([toast(1)], [{ toast: toast(9), index: 5 }]))).toEqual([1, 9]);
  });
});
