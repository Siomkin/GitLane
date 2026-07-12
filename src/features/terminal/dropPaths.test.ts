import { describe, it, expect } from "vitest";
import { shellQuotePaths } from "./dropPaths";

describe("shellQuotePaths", () => {
  it("returns empty string for no paths", () => {
    expect(shellQuotePaths([])).toBe("");
  });

  it("single-quotes a path and adds a trailing space", () => {
    expect(shellQuotePaths(["/home/me/notes.txt"])).toBe(
      "'/home/me/notes.txt' ",
    );
  });

  it("quotes paths with spaces so they stay one argument", () => {
    expect(shellQuotePaths(["/home/me/my file.txt"])).toBe(
      "'/home/me/my file.txt' ",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuotePaths(["/tmp/it's here"])).toBe("'/tmp/it'\\''s here' ");
  });

  it("joins multiple paths with a space", () => {
    expect(shellQuotePaths(["/a", "/b"])).toBe("'/a' '/b' ");
  });
});
