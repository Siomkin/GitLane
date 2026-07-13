// The fallback command is copied for the user to paste into whatever terminal
// they run — zsh/bash on macOS, but also cmd.exe or PowerShell on Windows, where
// POSIX quoting rules don't apply. Rather than emit shell-specific quoting, we
// only ever interpolate a host we've validated as a bare hostname: such a value
// contains no shell metacharacters, so it needs no quoting and pastes safely and
// identically into every shell.
//
// The fallbacks are deliberate. `gh auth login --web` without `--hostname` does
// NOT prompt for a host — it goes straight to github.com (login.go defaults the
// hostname whenever `--web` is set). So a host we can't validate must not fall
// back to the hostless `--web` form: that would silently sign the user into the
// wrong host. Plain `gh auth login` IS interactive and asks GitHub.com vs GHES,
// so that's the safe fallback for a host we refuse to interpolate.

const DOTCOM_COMMAND = "gh auth login --web";
const INTERACTIVE_COMMAND = "gh auth login";

/**
 * A conservative hostname matcher: dot-separated labels of letters, digits,
 * hyphens, and underscores (seen in intranet GHES names). It deliberately
 * rejects spaces, quotes, and every shell metacharacter (`;`, `&`, `|`, `$`,
 * `` ` ``, `(`, `/`, `@`, …), which is what makes unquoted interpolation safe.
 * No port: `gh` rejects any `--hostname` containing `:` (HostnameValidator).
 */
const HOST_PATTERN =
  /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;

/** Build the copyable `gh` fallback without letting the host become shell syntax. */
export function githubSigninCommand(host: string): string {
  // Match the backend's normalize_host: case-fold, and drop the root-dot form
  // of an FQDN (DNS treats `ghe.acme.com.` as `ghe.acme.com`).
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "github.com") return DOTCOM_COMMAND;
  if (!HOST_PATTERN.test(normalized)) return INTERACTIVE_COMMAND;
  return `gh auth login --hostname ${normalized} --web`;
}
