// Person-valued git trailers parsed from a commit message body.
//
// Conventions covered (investigated across ecosystems):
// - GitHub / GitLab pairing:  Co-authored-by
// - DCO / kernel sign-off:    Signed-off-by
// - kernel SubmittingPatches: Acked-by, Reviewed-by, Tested-by, Reported-by,
//                             Suggested-by, Co-developed-by
// - git.git's own history:    Helped-by, Mentored-by
// plus Cc. Rather than a closed list, any `Something-by:` trailer whose value
// has the `Name <email>` shape counts — that covers ad-hoc variants
// (e.g. Reviewed-and-tested-by) without new code.
//
// Trailers are matched line-wise over the whole body (like GitHub does for
// Co-authored-by) instead of only the strict final trailer block, because
// real-world messages frequently interleave trailers with prose.

export interface TrailerPerson {
  name: string;
  email: string;
}

export interface CommitTrailer extends TrailerPerson {
  /** Display key, normalized to git's conventional casing: `Co-authored-by`. */
  key: string;
}

export interface TrailerGroup {
  key: string;
  people: TrailerPerson[];
}

const TRAILER_LINE =
  /^[ \t]*([A-Za-z][A-Za-z0-9-]{0,63}):[ \t]*(.*?)[ \t]*<([^<>\s]+@[^<>\s]+)>[ \t]*$/gm;
const PERSON_KEY = /(?:-by|^cc)$/i;

/** All person-valued trailers in the body, in order of appearance. */
export function parsePersonTrailers(body: string): CommitTrailer[] {
  const trailers: CommitTrailer[] = [];
  for (const match of body.matchAll(TRAILER_LINE)) {
    const rawKey = match[1];
    if (!PERSON_KEY.test(rawKey)) continue;
    // The contract is `Name <email>`: a nameless `Co-authored-by: <email>` line
    // would otherwise surface as a blank person with a "?" badge.
    const name = match[2].trim();
    if (!name) continue;
    trailers.push({
      key: normalizeTrailerKey(rawKey),
      name,
      email: match[3],
    });
  }
  return trailers;
}

/** Trailers grouped by key, keeping first-appearance order of both keys and
 * people, with duplicate people (same email) collapsed inside a group. */
export function groupTrailers(trailers: CommitTrailer[]): TrailerGroup[] {
  const groups = new Map<string, TrailerGroup>();
  for (const trailer of trailers) {
    let group = groups.get(trailer.key);
    if (!group) {
      group = { key: trailer.key, people: [] };
      groups.set(trailer.key, group);
    }
    if (!group.people.some((person) => sameIdentity(person.email, trailer.email))) {
      group.people.push({ name: trailer.name, email: trailer.email });
    }
  }
  return [...groups.values()];
}

/** Unique people across all trailers, first-appearance order, optionally
 * excluding an email (the commit author, so they don't appear twice). */
export function uniqueTrailerPeople(
  trailers: readonly CommitTrailer[],
  excludeEmail?: string,
): TrailerPerson[] {
  const people: TrailerPerson[] = [];
  for (const trailer of trailers) {
    if (excludeEmail !== undefined && sameIdentity(trailer.email, excludeEmail)) continue;
    if (!people.some((person) => sameIdentity(person.email, trailer.email))) {
      people.push({ name: trailer.name, email: trailer.email });
    }
  }
  return people;
}

function sameIdentity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `co-AUTHORED-by` → `Co-authored-by` (git's conventional trailer casing). */
function normalizeTrailerKey(key: string): string {
  const lower = key.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
