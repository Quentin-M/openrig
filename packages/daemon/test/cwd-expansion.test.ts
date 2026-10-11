import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { expandCwd, resolveLaunchCwd } from "../src/domain/cwd-resolution.js";

describe("cwd expansion", () => {
  const env = { WORK: "/srv/work", NAME: "proj" };

  it("expands a leading ~ to the home directory", () => {
    expect(expandCwd("~", env, "/home/q")).toBe("/home/q");
    expect(expandCwd("~/code/app", env, "/home/q")).toBe("/home/q/code/app");
  });

  it("leaves ~user and a mid-path ~ alone", () => {
    expect(expandCwd("~other/app", env, "/home/q")).toBe("~other/app");
    expect(expandCwd("a/~/b", env, "/home/q")).toBe("a/~/b");
  });

  it("expands $VAR and ${VAR}", () => {
    expect(expandCwd("$WORK/$NAME", env, "/h")).toBe("/srv/work/proj");
    expect(expandCwd("${WORK}/${NAME}-x", env, "/h")).toBe("/srv/work/proj-x");
  });

  it("keeps a reference to an unset variable as written", () => {
    expect(expandCwd("$MISSING/app", env, "/h")).toBe("$MISSING/app");
  });

  it("resolveLaunchCwd treats an expanded path as absolute, not relative to the spec root", () => {
    expect(resolveLaunchCwd("~/code", "/spec/root")).toBe(`${homedir()}/code`);
    process.env["OPENRIG_TEST_CWD"] = "/opt/ws";
    try {
      expect(resolveLaunchCwd("$OPENRIG_TEST_CWD/app", "/spec/root")).toBe("/opt/ws/app");
    } finally { delete process.env["OPENRIG_TEST_CWD"]; }
  });

  it("relative paths still resolve against the spec root; an override wins", () => {
    expect(resolveLaunchCwd("sub", "/spec/root")).toBe("/spec/root/sub");
    expect(resolveLaunchCwd("~/x", "/spec/root", "/override")).toBe("/override");
  });
});
