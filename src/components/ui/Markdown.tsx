// GitHub-flavored markdown for PR descriptions and other bodies. The renderer
// (react-markdown, remark/rehype, and the HTML sanitizer) lives in
// `MarkdownRenderer.tsx` and loads lazily, so those libraries stay off the
// startup path. Do not import from it statically here.

import { lazy, Suspense } from "react";

const LazyMarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

export const Markdown = ({ content }: { content: string }) => {
  if (!content.trim()) {
    return <div className="text-[13px] italic text-neutral-400">No description.</div>;
  }
  // Fallback is null, not the raw source: a raw fallback would flash unrendered HTML.
  return (
    <Suspense fallback={null}>
      <LazyMarkdownRenderer content={content} />
    </Suspense>
  );
};
