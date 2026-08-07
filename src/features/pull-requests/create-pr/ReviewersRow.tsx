// Reviewer chips plus the add-menu. Renders nothing when the provider offered
// no candidates — GitLab and Bitbucket have no reviewer lookup here, and a
// GitHub caller without push access gets an empty list, so an empty picker
// would be a dead control rather than a feature.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/prs";
import type { PrReviewerCandidate } from "@/lib/api";

export function ReviewersRow({
  candidates,
  selected,
  onSelected,
}: {
  candidates: PrReviewerCandidate[];
  /** Logins, in the order they were picked. */
  selected: string[];
  onSelected: (logins: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  if (candidates.length === 0) return null;

  const toggle = (login: string) =>
    onSelected(
      selected.includes(login) ? selected.filter((l) => l !== login) : [...selected, login],
    );

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-400">
        Reviewers
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((login) => {
          const person = candidates.find((c) => c.login === login);
          return (
            <span
              key={login}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-black/10 pl-1 pr-2 dark:border-white/10"
            >
              <Avatar name={person?.name ?? login} login={login} />
              <span className="text-[12.5px] text-neutral-700 dark:text-neutral-200">
                {person?.name ?? login}
              </span>
              <button
                type="button"
                aria-label={`Remove ${login}`}
                onClick={() => toggle(login)}
                className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                  className="h-3 w-3"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </span>
          );
        })}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="inline-flex h-[26px] items-center gap-1 rounded-full border border-dashed border-black/20 px-2.5 text-[12.5px] text-neutral-500 hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] dark:border-white/20 dark:text-neutral-400"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
              className="h-3 w-3"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add
          </button>
          {open && (
            <div className="absolute bottom-8 left-0 z-30 max-h-[220px] w-[220px] overflow-auto rounded-xl border border-black/10 bg-white p-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.38)] dark:border-white/10 dark:bg-neutral-800">
              {candidates.map((person) => (
                <button
                  key={person.login}
                  type="button"
                  onClick={() => toggle(person.login)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  <Avatar name={person.name} login={person.login} />
                  <span className="truncate text-[13px] text-neutral-800 dark:text-neutral-100">
                    {person.name}
                  </span>
                  {selected.includes(person.login) && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      aria-hidden="true"
                      className="ml-auto h-3.5 w-3.5 text-[color:var(--accent)]"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Initials rather than the avatar URL: remote images are gated app-wide. */
function Avatar({ name, login }: { name: string; login: string }) {
  return (
    <span
      className={cn(
        "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full",
        "bg-neutral-400 text-[9px] font-bold text-white dark:bg-neutral-600",
      )}
    >
      {initials(name, login)}
    </span>
  );
}
