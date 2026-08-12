// The busy indicator shown while an agent request is in flight, shared by the
// commit-draft banner and the inline change description.
//
// Inherits `currentColor` and sizes off the surrounding text, so it sits inside
// an accent-tinted status row without either surface hard-coding a colour.
// Decorative: the surrounding row already carries `role="status"` with the text
// a screen reader should read, so this is hidden from the accessibility tree.

export function AgentSpinner({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 animate-spin ${className}`}
      fill="none"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
