import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { CommandError } from "@/lib/api";
import { missingRepoKindOf } from "./repoMissing";

describe("missingRepoKindOf for remote repositories", () => {
  it("an unreachable host is disconnected, not missing", () => {
    expect(missingRepoKindOf(new CommandError({ kind: "remoteUnavailable", code: "disconnected", message: "lost devbox" }))).toBe(
      "disconnected",
    );
  });

  it("keeps the local classification", () => {
    expect(missingRepoKindOf(new CommandError({ kind: "missingPath", message: "gone", path: "/r" }))).toBe("missing");
    expect(missingRepoKindOf(new CommandError({ kind: "git", message: "other" }))).toBeNull();
  });
});
