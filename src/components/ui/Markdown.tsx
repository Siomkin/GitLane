// GitHub-flavored markdown renderer for PR descriptions. Raw GitHub HTML is
// parsed only after it passes through a GitHub-style sanitizer, then rendered
// through the same themed components as normal markdown. Links open in the OS
// browser via the opener plugin rather than navigating the Tauri webview.

import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as RehypeSanitizeOptions } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openExternalUrl } from "@/lib/openExternal";

// Inline images are narrowed to a small raster allowlist with a length cap. SVG is
// excluded on purpose — `data:image/svg+xml` can carry script/foreignObject — and
// the cap is on the data-URI *string length* (a deliberately cheap proxy: we don't
// base64-decode untrusted markdown just to measure it), which keeps the rendered
// blob roughly bounded so a PR can't wedge the view with a multi-megabyte image.
// `markdownUrlTransform` and `isTrustedImageSrc` are the two gates; keep both
// pointed at `isSafeDataImage`.
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;
const MAX_DATA_IMAGE_URI_CHARS = 256 * 1024;

function isSafeDataImage(url: string): boolean {
  return url.length <= MAX_DATA_IMAGE_URI_CHARS && SAFE_DATA_IMAGE.test(url);
}

const markdownHtmlSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    // `data:` is allowed broadly here only so inline images survive sanitization;
    // `markdownUrlTransform` is the real gate that narrows it to safe raster
    // `data:image/*`. Keep the two in sync — widening one without the other
    // re-opens the hole.
    src: ["http", "https", "data"],
  },
  strip: [...(defaultSchema.strip ?? []), "style"],
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "picture" && tag !== "source"),
};

const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key === "src" && isSafeDataImage(url)) return url;
  return defaultUrlTransform(url);
};

function priorityBadge(src: string, alt: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "img.shields.io") return null;

    const badge = url.pathname.match(/\/badge\/([^/?#]+)/)?.[1];
    const parts = badge?.replace(/\.svg$/i, "").split("-").map(decodeURIComponent) ?? [];
    const label = parts.find((part) => /^P\d$/i.test(part)) ?? alt.match(/\b(P\d)\b/i)?.[1];
    return label?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

// Untrusted PR/issue markdown can embed remote images that beacon the viewer's
// IP and client version to the author's server the moment they auto-load. Only
// data: URIs and GitHub's user-content CDN are trusted to load directly; any
// other source renders as a labelled placeholder rather than being fetched.
function isTrustedImageSrc(src: string): boolean {
  if (isSafeDataImage(src)) return true;
  try {
    const url = new URL(src);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "githubusercontent.com" || host.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-[18px] text-[15.5px] font-bold text-neutral-800 first:mt-0 dark:text-neutral-100">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-[18px] text-[14.5px] font-bold text-neutral-800 first:mt-0 dark:text-neutral-100">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-4 text-[13.5px] font-bold text-neutral-800 first:mt-0 dark:text-neutral-100">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-4 text-[13px] font-bold text-neutral-600 first:mt-0 dark:text-neutral-300">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1.5 mt-3 text-[12.5px] font-bold text-neutral-600 first:mt-0 dark:text-neutral-300">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1.5 mt-3 text-[12px] font-bold uppercase text-neutral-500 first:mt-0 dark:text-neutral-400">{children}</h6>
  ),
  p: ({ children }) => (
    <p className="mb-2.5 text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-300">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternalUrl(href);
      }}
      className="cursor-pointer text-[#3b7ff5] underline underline-offset-2 hover:brightness-110"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mb-2.5 flex flex-col gap-[5px] pl-1">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-2.5 ml-5 list-decimal flex-col gap-[5px] text-[13px] text-neutral-600 dark:text-neutral-300">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="flex gap-2.5 text-[13px] leading-relaxed text-neutral-600 marker:text-neutral-400 dark:text-neutral-300">
      <span className="mt-[2px] flex-none text-neutral-400">•</span>
      <span className="min-w-0">{children}</span>
    </li>
  ),
  strong: ({ children }) => <strong className="font-semibold text-neutral-800 dark:text-neutral-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-neutral-400 line-through">{children}</del>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2.5 border-l-2 border-black/10 pl-3 text-[13px] italic text-neutral-500 dark:border-white/10 dark:text-neutral-400">
      {children}
    </blockquote>
  ),
  details: ({ children, open }) => (
    <details
      open={open}
      className="mb-2.5 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-[13px] text-neutral-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-300"
    >
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer select-none font-semibold text-neutral-800 marker:text-neutral-400 dark:text-neutral-100">
      {children}
    </summary>
  ),
  hr: () => <hr className="my-4 border-black/5 dark:border-white/5" />,
  code: ({ className, children }) => {
    const isBlock = (className ?? "").startsWith("language-") || String(children).includes("\n");
    if (isBlock) {
      return <code className="font-mono text-[12px] text-neutral-600 dark:text-neutral-300">{children}</code>;
    }
    return (
      <code className="rounded-[5px] bg-rose-500/[0.09] px-1.5 py-px font-mono text-[12px] text-rose-600 dark:text-rose-300">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2.5 overflow-auto rounded-lg border border-black/10 bg-black/[0.03] p-3 text-[12px] leading-relaxed dark:border-white/10 dark:bg-white/[0.04]">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-2.5 overflow-auto rounded-lg border border-black/10 dark:border-white/10">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-black/5 bg-black/[0.03] px-3 py-1.5 text-left font-semibold text-neutral-600 dark:border-white/5 dark:bg-white/[0.04] dark:text-neutral-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-black/5 px-3 py-1.5 text-neutral-600 last:border-b-0 dark:border-white/5 dark:text-neutral-300">{children}</td>
  ),
  img: ({ src, alt }) => {
    const altText = alt ?? "";
    if (typeof src === "string") {
      const badge = priorityBadge(src, altText);
      if (badge) {
        return (
          <span className="mr-2 inline-grid h-[22px] min-w-[30px] place-items-center rounded-[5px] border border-yellow-700/20 bg-[#c9b800] px-1.5 align-[-3px] font-mono text-[13px] font-medium leading-none text-white shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)]">
            {badge}
          </span>
        );
      }
    }
    if (typeof src === "string" && isTrustedImageSrc(src)) {
      return <img src={src} alt={altText} className="my-2 max-w-full rounded-md" />;
    }
    return (
      <span className="my-2 inline-flex items-center gap-1 rounded-md border border-black/10 px-2 py-1 text-[12px] italic text-neutral-400 dark:border-white/10">
        {altText || "image"}
      </span>
    );
  },
};

export const Markdown = ({ content }: { content: string }) => {
  if (!content.trim()) {
    return <div className="text-[13px] italic text-neutral-400">No description.</div>;
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownHtmlSchema]]}
      urlTransform={markdownUrlTransform}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
};
