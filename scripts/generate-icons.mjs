// Generates the GitLane app-icon set from the approved design SVGs in
// src-tauri/icons/source/ (exported from Claude Design project a65ff56d,
// "App Icon · Corner Tag", Aurora palette).
//
// Two source variants, picked per output size:
//   app-icon-gl.svg    — branch mark + GL wordmark   → large sizes (>=128px)
//   app-icon-mark.svg  — clean branch mark only      → small sizes (<128px)
// The GL wordmark uses Outfit ExtraBold; the vendored "Outfit[wght].ttf" is
// loaded so it renders exactly (falls back to system fonts if absent).
//
// Outputs into src-tauri/icons/: the standalone PNGs tauri.conf references, the
// Windows Store logos, a multi-size icon.icns (iconutil) and icon.ico (png-to-ico).
//
//   node scripts/generate-icons.mjs   (deps: @resvg/resvg-js, png-to-ico, macOS iconutil)

import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ICONS = fileURLToPath(new URL("../src-tauri/icons/", import.meta.url));
const SRC = join(ICONS, "source");

const SVG = {
  gl: readFileSync(join(SRC, "app-icon-gl.svg"), "utf8"),
  mark: readFileSync(join(SRC, "app-icon-mark.svg"), "utf8"),
};
// Static ExtraBold instance (resvg doesn't apply the wght axis of the variable
// "Outfit[wght].ttf", so a baked 800 instance is loaded instead). Re-create with:
//   fonttools varLib.instancer "Outfit[wght].ttf" wght=800 -o Outfit-ExtraBold.ttf
const FONT = join(SRC, "Outfit-ExtraBold.ttf");
const fontFiles = existsSync(FONT) ? [FONT] : [];
if (!fontFiles.length) console.warn("Outfit-ExtraBold.ttf not found — GL wordmark will use a system fallback.");

// >=128px gets the wordmark variant; smaller is mark-only.
function png(px) {
  const r = new Resvg(px >= 128 ? SVG.gl : SVG.mark, {
    font: { loadSystemFonts: true, fontFiles, defaultFontFamily: "Outfit" },
    fitTo: { mode: "width", value: px },
  });
  return r.render().asPng();
}

// Standalone PNGs referenced by tauri.conf.json + Windows Store logos.
const FILES = {
  "icon.png": 1024,
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "StoreLogo.png": 50,
};
for (const [name, size] of Object.entries(FILES)) writeFileSync(join(ICONS, name), png(size));

// macOS .icns via iconutil (.iconset of named slices).
const SET = "/tmp/gitlane.iconset";
rmSync(SET, { recursive: true, force: true });
mkdirSync(SET, { recursive: true });
const SLICES = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};
for (const [name, size] of Object.entries(SLICES)) writeFileSync(join(SET, name), png(size));
execFileSync("iconutil", ["-c", "icns", SET, "-o", join(ICONS, "icon.icns")]);

// Windows .ico (multi-size).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(join(ICONS, "icon.ico"), await pngToIco(icoSizes.map((s) => png(s))));

console.log("Wrote icons to", ICONS);
