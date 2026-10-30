import { describe, expect, it } from "vitest";
import {
  childOf,
  crumbsOf,
  fieldsOf,
  hostFieldsProblem,
  originOf,
  parentOf,
  pathProblem,
  recentOrigins,
} from "./model";

describe("open-remote host fields", () => {
  it("accepts an alias, a user and a port; refuses options, spaces and separators", () => {
    expect(hostFieldsProblem({ host: "devbox", user: "", port: "" })).toBeNull();
    expect(hostFieldsProblem({ host: "build.example", user: "me", port: "2222" })).toBeNull();
    expect(hostFieldsProblem({ host: "-oProxyCommand=x", user: "", port: "" })).not.toBeNull();
    expect(hostFieldsProblem({ host: "dev box", user: "", port: "" })).not.toBeNull();
    expect(hostFieldsProblem({ host: "me@devbox", user: "", port: "" })).not.toBeNull();
    expect(hostFieldsProblem({ host: "devbox", user: "-l", port: "" })).not.toBeNull();
    expect(hostFieldsProblem({ host: "devbox", user: "", port: "70000" })).not.toBeNull();
  });

  it("round-trips fields through an origin", () => {
    const fields = { host: "build.example", user: "me", port: "2222" };
    expect(originOf(fields)).toBe("ssh://me@build.example:2222");
    expect(fieldsOf("ssh://me@build.example:2222")).toEqual(fields);
    expect(fieldsOf("ssh://devbox")).toEqual({ host: "devbox", user: "", port: "" });
  });

  it("lists recent remote hosts once each, newest first", () => {
    expect(
      recentOrigins(["ssh://devbox/srv/a", "/local", "ssh://me@ci:22/x", "ssh://devbox/srv/b"]),
    ).toEqual(["ssh://devbox", "ssh://me@ci:22"]);
  });
});

describe("open-remote folder steps", () => {
  it("needs an absolute server path without ~", () => {
    expect(pathProblem("/srv/app")).toBeNull();
    expect(pathProblem("srv/app")).not.toBeNull();
    expect(pathProblem("~/app")).not.toBeNull();
    expect(pathProblem("/~/app")).not.toBeNull();
  });

  it("walks up, down and along the breadcrumb", () => {
    expect(parentOf("/home/me/projects")).toBe("/home/me");
    expect(parentOf("/home")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(childOf("/", "home")).toBe("/home");
    expect(childOf("/home/me/", "app")).toBe("/home/me/app");
    expect(crumbsOf("/home/me")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
    ]);
  });
});
