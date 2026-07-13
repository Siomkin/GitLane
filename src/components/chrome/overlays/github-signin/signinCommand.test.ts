import { describe, expect, it } from "vitest";

import { githubSigninCommand } from "./signinCommand";

const DOTCOM = "gh auth login --web";
// `gh auth login --web` without --hostname silently targets github.com, so an
// unvalidatable host must fall back to the interactive (host-prompting) form.
const INTERACTIVE = "gh auth login";

describe("githubSigninCommand", () => {
  it("uses the short command for GitHub.com", () => {
    expect(githubSigninCommand("github.com")).toBe(DOTCOM);
  });

  it("case-folds GitHub.com to the short command", () => {
    expect(githubSigninCommand("GitHub.COM")).toBe(DOTCOM);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("uses the short command for %s", (_label, host) => {
    expect(githubSigninCommand(host)).toBe(DOTCOM);
  });

  it("emits an unquoted --hostname for a valid enterprise host", () => {
    expect(githubSigninCommand("github.acme.com")).toBe(
      "gh auth login --hostname github.acme.com --web",
    );
  });

  it("lowercases the host, matching the backend's normalize_host", () => {
    expect(githubSigninCommand("GitHub.Acme.COM")).toBe(
      "gh auth login --hostname github.acme.com --web",
    );
  });

  it("strips a trailing FQDN root dot", () => {
    expect(githubSigninCommand("github.acme.com.")).toBe(
      "gh auth login --hostname github.acme.com --web",
    );
  });

  it("trims surrounding whitespace before matching", () => {
    expect(githubSigninCommand("  github.acme.com  ")).toBe(
      "gh auth login --hostname github.acme.com --web",
    );
  });

  it("accepts an underscore intranet host", () => {
    expect(githubSigninCommand("ghe_internal.acme.com")).toBe(
      "gh auth login --hostname ghe_internal.acme.com --web",
    );
  });

  it("accepts an IPv4 literal", () => {
    expect(githubSigninCommand("10.0.0.5")).toBe(
      "gh auth login --hostname 10.0.0.5 --web",
    );
  });

  it.each([
    // gh's HostnameValidator rejects any --hostname containing ':'.
    ["a host:port", "github.acme.com:8443"],
    ["a shell-injection payload", "github.acme.com'; touch /tmp/pwned; echo '"],
    ["a lone quote", "'"],
    ["cmd.exe metacharacters", "github.acme.com & calc.exe"],
    ["a cmd.exe env expansion", "%COMSPEC%"],
    ["command substitution", "$(whoami)"],
    ["a PowerShell backtick", "github`whoami`.acme.com"],
    ["a URL with a path", "github.acme.com/login"],
    ["embedded credentials", "user@github.acme.com"],
    ["a newline", "github.acme.com\nrm -rf /"],
    ["a unicode IDN label", "github.例え.jp"],
  ])(
    "falls back to the interactive host prompt for %s",
    (_label, host) => {
      expect(githubSigninCommand(host)).toBe(INTERACTIVE);
    },
  );
});
