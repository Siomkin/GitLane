import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconBase>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.04a1.7 1.7 0 0 0 1.56 1H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </IconBase>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8Z" />
    </IconBase>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </IconBase>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2.5h6.5A2.5 2.5 0 0 1 21 9v8.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" />
    </IconBase>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M8 17c5 0 4-11 8-11" />
    </IconBase>
  );
}

export function PullIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v14" />
      <path d="m7 12 5 5 5-5" />
      <path d="M5 21h14" />
    </IconBase>
  );
}

export function PushIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 21V7" />
      <path d="m7 12 5-5 5 5" />
      <path d="M5 3h14" />
    </IconBase>
  );
}

export function FetchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 12a9 9 0 0 1 14.7-6.9L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-14.7 6.9L3 16" />
      <path d="M3 21v-5h5" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </IconBase>
  );
}

export function StashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      {/* changes dropping into the stash */}
      <path d="M12 3.5v5.5" />
      <path d="m9 6.5 3 3 3-3" />
      {/* the stash shelf / inbox tray */}
      <path d="M3 13h4.2l1.3 2.1a1 1 0 0 0 .85.47h5.3a1 1 0 0 0 .85-.47L16.8 13H21v4.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5V13Z" />
    </IconBase>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  );
}

export function LaptopIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </IconBase>
  );
}

export function CloudIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 18 18Z" />
    </IconBase>
  );
}

export function TreeIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M12 3l5 7h-3l4 6H6l4-6H7z" />
      <path d="M12 16v5" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 18 6-6-6-6" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="2" {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="2.2" {...props}>
      <path d="m5 12 5 5L20 7" />
    </IconBase>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.3.2 2.3.1 2.6a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.8v2.6c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// File-type glyphs. Each is a recognizable mark (braces for JSON, a terminal
// for shell, the markdown logo, …) — like the React atom for .tsx — rather
// than the extension spelled out in a box. Shared builders keep them terse.
// ---------------------------------------------------------------------------

// A genuine brand logo that happens to be lettered (TS, JS): colored square.
function brandSquare(bg: string, label: string, fg: string) {
  return (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill={bg} />
      <text
        x="12.25"
        y="16.4"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="9.5"
        fontWeight="700"
        fill={fg}
      >
        {label}
      </text>
    </>
  );
}

// Picture frame with a tiny landscape — shared by raster images and svg.
function imageGlyph(c: string) {
  return (
    <g fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <circle cx="8.5" cy="9.5" r="1.7" fill={c} stroke="none" />
      <path d="M4.5 17.5l4.5-4.5 3 3 3.5-3.5 4 4" strokeLinecap="round" />
    </g>
  );
}

// Neutral folded page, tinted — the fallback for types without a logo.
function docGlyph(c: string) {
  return (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill={c} />
      <path d="M14 3l5 5h-4a1 1 0 0 1-1-1z" fill="rgba(0,0,0,.28)" />
    </>
  );
}

// A "#" — for stylesheet languages.
function hashGlyph(c: string) {
  return (
    <g stroke={c} strokeWidth="1.7" strokeLinecap="round">
      <path d="M9.6 4.8L7.6 19.2" />
      <path d="M16.4 4.8L14.4 19.2" />
      <path d="M5.4 9.2H18.6" />
      <path d="M4.9 14.8H18.1" />
    </g>
  );
}

// "</>" — for markup/template languages.
function codeGlyph(c: string) {
  return (
    <g fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 8L4 12l4 4" />
      <path d="M16 8l4 4-4 4" />
      <path d="M13.5 6.5L10.5 17.5" />
    </g>
  );
}

const SETTINGS_COG =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";

// Tint for the folded-page fallback, by extension. No logo, just a color.
const DOC_TINT: Record<string, string> = {
  py: "#4b8bbe", go: "#46b5d1", rb: "#c0392b", java: "#b07219", kt: "#a97bf0",
  swift: "#f05138", c: "#5a78b0", h: "#5a78b0", cpp: "#5a78b0", cc: "#5a78b0",
  hpp: "#5a78b0", cs: "#68217a", php: "#7377ad", lua: "#5b6bd6", dart: "#0a99c4",
  ex: "#9b7bc0", exs: "#9b7bc0", txt: "#9aa0aa", csv: "#5a9b6b", tsv: "#5a9b6b",
  graphql: "#e535ab", gql: "#e535ab", proto: "#7a8ab5", env: "#d6b73c",
  gitignore: "#e8693f", gitattributes: "#e8693f", gitmodules: "#e8693f",
  license: "#9aa0aa", dockerfile: "#3a8cc4", makefile: "#8a8f99",
};

/** Returns the inner SVG glyph for a file extension (or whole filename for
 * extensionless files). Recognizable logos first; tinted page as fallback. */
function glyphFor(ext: string) {
  switch (ext) {
    case "tsx":
    case "jsx": {
      const c = "#61dafb";
      return (
        <>
          <circle cx="12" cy="12" r="1.9" fill={c} />
          <g stroke={c} strokeWidth="1" fill="none">
            <ellipse cx="12" cy="12" rx="10" ry="4.2" />
            <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)" />
          </g>
        </>
      );
    }
    case "ts":
    case "mts":
    case "cts":
      return brandSquare("#3178c6", "TS", "#fff");
    case "js":
    case "mjs":
    case "cjs":
      return brandSquare("#f7df1e", "JS", "#111");
    case "json":
    case "jsonc":
    case "json5":
      return (
        <>
          <g fill="none" stroke="#cbcb41" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.2 4.5C7.6 4.5 7.1 5.4 7.1 6.9c0 1.2.2 2.3-.5 3.2-.3.45-.85.7-1.3.9.45.2 1 .45 1.3.9.7.9.5 2 .5 3.2 0 1.5.5 2.4 2.1 2.4" />
            <path d="M14.8 4.5c1.6 0 2.1.9 2.1 2.4 0 1.2-.2 2.3.5 3.2.3.45.85.7 1.3.9-.45.2-1 .45-1.3.9-.7.9-.5 2-.5 3.2 0 1.5-.5 2.4-2.1 2.4" />
          </g>
          <circle cx="12" cy="12" r="1.15" fill="#cbcb41" />
        </>
      );
    case "md":
    case "mdx":
    case "markdown":
      return (
        <g fill="none" stroke="#519aba" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.2" />
          <path d="M6 15.5V9.2l3 3.4 3-3.4v6.3" />
          <path d="M16.4 9.2v5.8m0 0l-2-2.1m2 2.1l2-2.1" />
        </g>
      );
    case "css":
      return hashGlyph("#42a5f5");
    case "scss":
    case "sass":
      return hashGlyph("#cd6799");
    case "less":
      return hashGlyph("#2a6db5");
    case "html":
    case "htm":
      return codeGlyph("#e44d26");
    case "xml":
    case "plist":
      return codeGlyph("#b0905a");
    case "vue":
      return (
        <>
          <path d="M2.5 4.5h4L12 13.2 17.5 4.5h4L12 21z" fill="#41b883" />
          <path d="M6.5 4.5h3L12 8.8l2.5-4.3h3L12 15.8z" fill="#35495e" />
        </>
      );
    case "svg":
      return imageGlyph("#cf913b");
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "ico":
    case "icns":
    case "avif":
    case "tiff":
    case "heic":
      return imageGlyph("#a877d6");
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ps1":
    case "bat":
    case "cmd":
      return (
        <>
          <rect x="2.5" y="4" width="19" height="16" rx="2.6" fill="#33373f" />
          <path d="M6 9l3 3-3 3" fill="none" stroke="#5af78e" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11.8 15.5h4.2" stroke="#5af78e" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case "sql":
    case "db":
    case "sqlite":
      return (
        <g fill="none" stroke="#dba617" strokeWidth="1.6">
          <ellipse cx="12" cy="6" rx="6.5" ry="2.6" />
          <path d="M5.5 6v12c0 1.45 2.9 2.6 6.5 2.6s6.5-1.15 6.5-2.6V6" />
          <path d="M5.5 12c0 1.45 2.9 2.6 6.5 2.6s6.5-1.15 6.5-2.6" />
        </g>
      );
    case "yml":
    case "yaml":
    case "toml":
    case "ini":
    case "conf":
    case "cfg":
    case "editorconfig":
    case "properties":
      return <path d={SETTINGS_COG} fill="#8f86d6" />;
    case "rs":
      return <path d={SETTINGS_COG} fill="#d98a5a" />;
    case "lock":
      return (
        <g fill="none" stroke="#9aa0aa" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        </g>
      );
    case "pdf":
      return docGlyph("#c0392b");
    case "zip":
    case "tar":
    case "gz":
    case "tgz":
    case "rar":
    case "7z":
    case "xz":
    case "bz2":
      return (
        <g fill="none" stroke="#c8a04e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.7 7.6L12 3l8.3 4.6v8.8L12 21l-8.3-4.6z" />
          <path d="M3.7 7.6L12 12.2l8.3-4.6M12 12.2V21" />
        </g>
      );
    default:
      return docGlyph(DOC_TINT[ext] ?? "#7e8696");
  }
}

/** File-type icon: a recognizable glyph per type (the React atom for .tsx,
 * braces for JSON, a terminal for shell, …) — never the bare extension as
 * text. Unknown types fall back to a neutral tinted page. */
export function FileIcon({ path, size = 18 }: { path: string; size?: number }) {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  // Extensionless/dotfiles (e.g. "dockerfile", ".gitignore") key on the whole
  // name, which is what split(".").pop() yields for them.
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : name;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: "none" }} aria-hidden="true">
      {glyphFor(ext)}
    </svg>
  );
}

export function PullRequestIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v10" />
      <path d="M18 16V9a3 3 0 0 0-3-3h-2" />
      <path d="m13 3-3 3 3 3" />
    </IconBase>
  );
}
