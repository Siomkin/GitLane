import { describe, expect, it } from "vitest";
import { binaryFileKind, changeVerb, formatBytes, formatDelta } from "./binaryFile";

describe("formatBytes", () => {
  it("formats bytes, KB and MB with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB"); // ≥10 ⇒ no decimal
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("guards against negative / non-finite input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });
});

describe("formatDelta", () => {
  it("signs the difference and shows ±0 for no change", () => {
    expect(formatDelta(1024, 2048)).toBe("+1.0 KB");
    expect(formatDelta(2048, 1024)).toBe("−1.0 KB");
    expect(formatDelta(1024, 1024)).toBe("±0 B");
  });
});

describe("binaryFileKind", () => {
  it("classifies image types as previewable with a MIME", () => {
    expect(binaryFileKind("assets/logo.png")).toMatchObject({
      isImage: true,
      mime: "image/png",
      label: "PNG image",
    });
    expect(binaryFileKind("a/b/photo.JPG").mime).toBe("image/jpeg");
  });

  it("labels common non-image binaries without a preview", () => {
    expect(binaryFileKind("docs/spec.pdf")).toMatchObject({ isImage: false, label: "PDF document" });
    expect(binaryFileKind("report.docx").label).toBe("Word document");
    expect(binaryFileKind("bundle.zip").label).toBe("Archive");
  });

  it("falls back to an extension/Binary label for unknown types", () => {
    expect(binaryFileKind("firmware.bin").label).toBe("BIN file");
    expect(binaryFileKind("Makefile").label).toBe("Binary file");
  });
});

describe("changeVerb", () => {
  it("maps git status letters to past-tense verbs", () => {
    expect(changeVerb("A")).toBe("Added");
    expect(changeVerb("U")).toBe("Added");
    expect(changeVerb("D")).toBe("Deleted");
    expect(changeVerb("M")).toBe("Modified");
    expect(changeVerb("R")).toBe("Renamed");
  });
});
