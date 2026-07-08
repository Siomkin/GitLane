import { describe, it, expect } from "vitest";
import { detectRemoteUrl } from "../../../lib/remotes";
import type { GitTransportAuthRef } from "../../../lib/api";
import { cloneAuthStatusLine, planCloneAuth, type CloneAuthInputs } from "./cloneAuth";

// Parity guard: this priority chain was extracted verbatim from startClone
// (selected account > entered token > keychain token > glab > bare username >
// system/SSH) — these tests pin the order and the exact refs produced.

const gh = detectRemoteUrl("https://github.com/octo/repo.git");
const gitlab = detectRemoteUrl("https://gitlab.com/group/repo.git");

const account = {
  login: "octocat",
  ref: { provider: "gh" as const, host: "github.com", accountId: "1", login: "octocat" },
};
const token = { provider: "gitlab" as const, accountId: "42", login: "ada", transportUsername: "oauth2" };
const glabRef: GitTransportAuthRef = {
  mode: "gitlabGlab",
  provider: "gitlab",
  host: "gitlab.com",
  credentialHost: "gitlab.com",
  username: "ada",
};

const inputs = (over: Partial<CloneAuthInputs>): CloneAuthInputs => ({
  remoteInfo: gitlab,
  selectedAccount: null,
  username: "",
  password: "",
  tokenForHost: undefined,
  glabRef: null,
  ...over,
});

describe("planCloneAuth priority order", () => {
  it("a selected gh account outranks everything", () => {
    const plan = planCloneAuth(
      inputs({ remoteInfo: gh, selectedAccount: account, username: "x", password: "tok", tokenForHost: token, glabRef }),
    );
    expect(plan.method).toBe("account");
    expect(plan.auth).toEqual({
      mode: "githubGh",
      provider: "github",
      host: "github.com",
      credentialHost: "github.com",
      username: "octocat",
      accountRef: account.ref,
    });
  });

  it("an entered token outranks keychain, glab, and bare username", () => {
    const plan = planCloneAuth(inputs({ username: "ada", password: "tok", tokenForHost: token, glabRef }));
    expect(plan.method).toBe("enteredToken");
    expect(plan.auth).toEqual({
      mode: "credentialHelper",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "ada",
    });
  });

  it("an entered token with a blank username keeps username null", () => {
    const plan = planCloneAuth(inputs({ password: "tok" }));
    expect(plan.method).toBe("enteredToken");
    expect(plan.auth?.username).toBeNull();
  });

  it("a keychain token outranks glab", () => {
    const plan = planCloneAuth(inputs({ tokenForHost: token, glabRef }));
    expect(plan.method).toBe("keychain");
    expect(plan.auth).toEqual({
      mode: "providerToken",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "oauth2",
      providerAccountId: "42",
    });
  });

  it("glab outranks a bare username", () => {
    const plan = planCloneAuth(inputs({ username: "ada", glabRef }));
    expect(plan.method).toBe("glab");
    expect(plan.auth).toBe(glabRef);
  });

  it("a bare username resolves through the system credential helper", () => {
    const plan = planCloneAuth(inputs({ username: "ada" }));
    expect(plan.method).toBe("system");
    expect(plan.auth).toEqual({
      mode: "credentialHelper",
      provider: "gitlab",
      host: "gitlab.com",
      credentialHost: "gitlab.com",
      username: "ada",
    });
  });

  it("nothing resolved → no auth ref (public repo / system defaults)", () => {
    const plan = planCloneAuth(inputs({}));
    expect(plan).toEqual({ auth: null, method: "system", login: null });
  });

  it("SSH URLs never build an HTTPS auth ref", () => {
    const plan = planCloneAuth(
      inputs({ remoteInfo: detectRemoteUrl("git@github.com:octo/repo.git"), password: "tok", tokenForHost: token }),
    );
    expect(plan).toEqual({ auth: null, method: "ssh", login: null });
  });

  it("maps azure remotes to the azure-devops transport provider", () => {
    const plan = planCloneAuth(
      inputs({ remoteInfo: detectRemoteUrl("https://dev.azure.com/org/proj/_git/repo"), username: "ada" }),
    );
    expect(plan.auth?.provider).toBe("azure-devops");
  });
});

describe("cloneAuthStatusLine", () => {
  it("names the resolved identity per method", () => {
    expect(cloneAuthStatusLine(planCloneAuth(inputs({ remoteInfo: gh, selectedAccount: account })))).toBe(
      "Will authenticate as @octocat via gh.",
    );
    expect(cloneAuthStatusLine(planCloneAuth(inputs({ tokenForHost: token })))).toBe(
      "Will authenticate as @ada via the GitLane keychain.",
    );
    expect(cloneAuthStatusLine(planCloneAuth(inputs({ glabRef })))).toBe(
      "Signed in via glab — authenticates automatically.",
    );
    expect(cloneAuthStatusLine(planCloneAuth(inputs({ password: "tok" })))).toBe(
      "Will authenticate with the token you entered.",
    );
    expect(cloneAuthStatusLine(planCloneAuth(inputs({ username: "ada" })))).toBe(
      "Will authenticate as ada via your system git credentials.",
    );
    expect(cloneAuthStatusLine(planCloneAuth(inputs({})))).toBe(
      "Will use your system git credentials if the repository is private.",
    );
    expect(
      cloneAuthStatusLine(planCloneAuth(inputs({ remoteInfo: detectRemoteUrl("git@github.com:o/r.git") }))),
    ).toBe("SSH — authenticates with your SSH key.");
  });
});
