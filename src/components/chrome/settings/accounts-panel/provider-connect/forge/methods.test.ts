import { describe, expect, it } from "vitest";
import type { ForgeAuthStatus } from "@/lib/api";
import { forgeCapabilities, forgeMethods, initialForgeMethod } from "./methods";

const gitlab: ForgeAuthStatus = {
  provider: "gitlab",
  forge: "GitLab",
  cli: "glab",
  authMethod: "GitLab CLI",
  available: true,
  authenticated: null,
  loginCommand: "glab auth login",
  docsUrl: "https://gitlab.com/gitlab-org/cli",
  notes: "",
};
const bitbucket: ForgeAuthStatus = { ...gitlab, provider: "bitbucket", forge: "Bitbucket", cli: null, authMethod: "Git credential helper / GCM or SSH" };
const gitea: ForgeAuthStatus = { ...gitlab, provider: "gitea", forge: "Gitea", cli: "tea", authMethod: "tea CLI" };

const prs = (status: ForgeAuthStatus, method: "cli" | "token" | "ssh", storage?: "keychain" | "helper") =>
  forgeCapabilities(status, method, storage)[2];

describe("forge Connect methods", () => {
  it("puts the provider CLI first when it has one, then Access token and SSH key", () => {
    expect(forgeMethods(gitlab).map((m) => m.label)).toEqual(["GitLab CLI", "Access token", "SSH key"]);
    expect(forgeMethods(bitbucket).map((m) => m.value)).toEqual(["token", "ssh"]);
  });

  it("opens on the CLI, else on Access token", () => {
    expect(initialForgeMethod(gitlab)).toBe("cli");
    expect(initialForgeMethod(bitbucket)).toBe("token");
  });

  it("says where pull requests come from for each method", () => {
    expect(prs(gitlab, "cli")).toMatchObject({ value: "Yes", tone: "yes" });
    expect(prs(gitlab, "token")).toMatchObject({ value: "Needs GitLab CLI", tone: "muted" });
    expect(prs(bitbucket, "ssh")).toMatchObject({ value: "Needs an API credential", tone: "muted" });
    expect(prs(gitea, "cli")).toMatchObject({ value: "Not in GitLane yet", tone: "muted" });
  });

  it("counts a keychain token as GitLab's and Bitbucket's pull-request credential", () => {
    expect(prs(gitlab, "token", "keychain")).toMatchObject({ value: "With the api scope", tone: "yes" });
    expect(prs(bitbucket, "token", "keychain")).toMatchObject({ value: "With pull request access", tone: "yes" });
    expect(prs(bitbucket, "token", "helper")).toMatchObject({ value: "Needs an API credential", tone: "muted" });
  });

  it("gives every method the four tiles and its own storage", () => {
    for (const method of ["cli", "token", "ssh"] as const) {
      expect(forgeCapabilities(gitlab, method).map((c) => c.label)).toEqual(["Fetch, pull", "Push", "Pull requests", "Stored by"]);
    }
    expect(forgeCapabilities(gitlab, "cli")[3].value).toBe("glab");
    expect(forgeCapabilities(gitlab, "token")[1].value).toBe("With write access");
    expect(forgeCapabilities(gitlab, "token", "keychain")[3].value).toBe("GitLane (keychain)");
    expect(forgeCapabilities(gitlab, "token", "helper")[3].value).toBe("Your helper");
    expect(forgeCapabilities(gitlab, "ssh")[3].value).toBe("Your key, ssh-agent");
  });

  it("claims git transport only for glab, the one CLI that answers Git's credential prompts", () => {
    expect(forgeCapabilities(gitlab, "cli")[0]).toMatchObject({ value: "Yes", tone: "yes" });
    const tea = forgeCapabilities(gitea, "cli");
    expect(tea.map((c) => c.label)).toEqual(["Fetch, pull", "Push", "Pull requests", "Stored by"]);
    expect(tea[0]).toMatchObject({ value: "Via helper or SSH", tone: "muted" });
    expect(tea[1]).toMatchObject({ value: "Via helper or SSH", tone: "muted" });
    expect(tea[3].value).toBe("tea");
  });
});
