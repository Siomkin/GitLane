import { useState } from "react";
import {
  groupTrailers,
  parsePersonTrailers,
  uniqueTrailerPeople,
  type TrailerPerson,
} from "@/lib/commitTrailers";
import { identityColor, type IdentityColorOverrides } from "@/lib/identityColor";
import { cn } from "@/lib/cn";
import { useUi } from "@/store/ui";
import { authorInitials, knownCommitAgent } from "@/features/graph/commitAgents";

/** Visual identity for a person (commit author or trailer participant) — an
 * agent's branded glyph, or a human's initials on their stable per-identity
 * colour (honouring the user's saved overrides). Shared so the graph node,
 * hover card, inspector author block, and trailer rows resolve identity the
 * same way — same initials algorithm, same colour, same agent branding. */
export function personVisual(person: TrailerPerson, overrides: IdentityColorOverrides) {
  const agent = knownCommitAgent(person.name, person.email);
  return {
    label: agent?.label ?? person.name,
    color: agent ? agent.color : identityColor(person.email || person.name, overrides),
    initials: authorInitials(person.name) ?? "?",
    iconUrl: agent?.iconUrl ?? null,
  };
}

/** Person trailers (Co-authored-by, Signed-off-by, Reviewed-by, …) rendered
 * inside the commit-detail author block — same responsibility, one surface.
 * A single person shows inline with their role; several collapse into an
 * expandable People row grouped by trailer role. */
export function CommitPeople({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const overrides = useUi((state) => state.identityColors);
  const trailers = parsePersonTrailers(body);
  if (trailers.length === 0) return null;

  const groups = groupTrailers(trailers);
  const people = uniqueTrailerPeople(trailers);

  if (people.length === 1 && groups.length === 1) {
    return (
      <div className="mt-3 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
        <div className="flex items-center gap-3">
          <RolePill role={groups[0].key} />
          <PersonRow person={people[0]} overrides={overrides} />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
      <button
        type="button"
        className="flex w-full items-center gap-2.5"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          People
        </span>
        <span className="flex items-center -space-x-1.5">
          {people.slice(0, 4).map((person) => (
            <PersonAvatar
              key={person.email}
              person={person}
              overrides={overrides}
              className="h-5 w-5 text-[8px] ring-2 ring-[#f6f6f6] dark:ring-neutral-800"
            />
          ))}
        </span>
        <span className="truncate text-[12.5px] text-neutral-400">
          {personVisual(people[0], overrides).label}
          {people.length > 1 ? ` +${people.length - 1}` : ""}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          className={cn("ml-auto h-4 w-4 shrink-0 text-neutral-400 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-2.5">
          {groups.map((group) => (
            <div key={group.key} className="flex gap-3">
              <div className="w-[128px] shrink-0 pt-0.5">
                <RolePill role={group.key} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {group.people.map((person) => (
                  <PersonRow key={person.email} person={person} overrides={overrides} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RolePill({ role }: { role: string }) {
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center rounded-md bg-black/[0.05] px-2 font-mono text-[11px] font-semibold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-400">
      {role}
    </span>
  );
}

function PersonRow({
  person,
  overrides,
}: {
  person: TrailerPerson;
  overrides: IdentityColorOverrides;
}) {
  const visual = personVisual(person, overrides);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PersonAvatar
        person={person}
        overrides={overrides}
        className="h-6 w-6 text-[9px]"
        iconClassName="h-4 w-4"
      />
      <span className="shrink-0 text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
        {visual.label}
      </span>
      <span className="truncate text-xs text-neutral-500 dark:text-neutral-400">{person.email}</span>
    </div>
  );
}

function PersonAvatar({
  person,
  overrides,
  className,
  iconClassName = "h-3 w-3",
}: {
  person: TrailerPerson;
  overrides: IdentityColorOverrides;
  className: string;
  iconClassName?: string;
}) {
  const visual = personVisual(person, overrides);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white",
        className,
      )}
      style={{ background: visual.color }}
    >
      {visual.iconUrl ? <img src={visual.iconUrl} alt="" className={iconClassName} /> : visual.initials}
    </span>
  );
}
