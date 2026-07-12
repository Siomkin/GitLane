import { Markdown } from "../../../components/ui/Markdown";

/** Rendered preview of a previewable file. Markdown today (reuses the shared
 * `components/ui/Markdown` renderer used for PR bodies); the single place to
 * extend for future previewable types (images/SVG). */
export function FilePreview({ text }: { text: string }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <Markdown content={text} />
    </div>
  );
}
