import { describe, expect, it } from "vitest";
import {
  childOf,
  connectionOf,
  crumbsOf,
  EMPTY_FORM,
  formOf,
  formProblem,
  parentOf,
  pathProblem,
  splitDestination,
} from "./model";

const form = (over: Partial<typeof EMPTY_FORM>) => ({ ...EMPTY_FORM, name: "Work", ...over });

describe("open-remote connection form", () => {
  it("accepts an alias, user@host, a port and a key path; refuses options and junk", () => {
    expect(formProblem(form({ host: "devbox" }), { needName: true })).toBeNull();
    expect(formProblem(form({ host: "me@build.example", port: "2222", identityFile: "~/.ssh/id" }), { needName: true })).toBeNull();
    expect(formProblem(form({ host: "-oProxyCommand=x" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ host: "dev box" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ host: "devbox", port: "70000" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ host: "devbox", identityFile: "-i" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ host: "devbox", identityFile: "keys/id" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ name: "", host: "devbox" }), { needName: true })).not.toBeNull();
    expect(formProblem(form({ name: "", host: "devbox" }), { needName: false })).toBeNull();
  });

  it("round-trips a connection through the form", () => {
    const connection = { name: "Work", host: "build.example", user: "me", port: 2222, identityFile: "~/.ssh/id" };
    expect(formOf(connection)).toEqual({ name: "Work", host: "me@build.example", port: "2222", identityFile: "~/.ssh/id" });
    expect(connectionOf(formOf(connection))).toEqual(connection);
    expect(connectionOf(form({ host: " devbox " }))).toEqual({
      name: "Work",
      host: "devbox",
      user: null,
      port: null,
      identityFile: null,
    });
    expect(splitDestination("a@b@c")).toEqual({ user: "a@b", host: "c" });
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
