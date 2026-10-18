import { describe, expect, it } from "vitest";
import { dispatch, ZyrkError } from "../src/cli/main.ts";
import { isGlobalInstallRequest, parseArgs } from "../src/cli/parse.ts";

const VERSION = "9.9.9-test";

describe("parseArgs", () => {
  it("splits the command from its arguments", () => {
    expect(parseArgs(["install", "--frozen-lockfile"])).toMatchObject({
      help: false,
      version: false,
      command: "install",
      commandArgs: ["--frozen-lockfile"],
      json: false,
    });
  });

  it("extracts --json anywhere before the separator", () => {
    const parsed = parseArgs(["--json", "install", "-g", "alpha"]);
    expect(parsed.json).toBe(true);
    expect(parsed.command).toBe("install");
    expect(parsed.commandArgs).toEqual(["-g", "alpha"]);
  });

  it("keeps flags before the command in the command arguments", () => {
    const parsed = parseArgs(["-g", "install", "alpha"]);
    expect(parsed.command).toBe("install");
    expect(parsed.commandArgs).toEqual(["-g", "alpha"]);
    expect(parsed.argsBeforeCommand).toEqual(["-g"]);
    expect(parsed.argsAfterCommand).toEqual(["alpha"]);
  });

  it("records leading options for delegation without consuming them", () => {
    const parsed = parseArgs(["--dry-run", "publish", "--tag", "beta"]);
    expect(parsed.command).toBe("publish");
    expect(parsed.argsBeforeCommand).toEqual(["--dry-run"]);
    expect(parsed.argsAfterCommand).toEqual(["--tag", "beta"]);
    expect(parseArgs(["publish"]).argsBeforeCommand).toEqual([]);
  });

  it("passes everything after -- through untouched", () => {
    const parsed = parseArgs(["run", "build", "--", "--json", "-g"]);
    expect(parsed.command).toBe("run");
    expect(parsed.json).toBe(false);
    expect(parsed.commandArgs).toEqual(["build", "--", "--json", "-g"]);
  });

  it("recognizes help and version requests", () => {
    expect(parseArgs([])).toMatchObject({ command: undefined });
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h", "install"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });
});

describe("isGlobalInstallRequest", () => {
  const clean: NodeJS.ProcessEnv = {};
  it.each([
    ["install", ["-g", "alpha"]],
    ["install", ["--global", "alpha"]],
    ["install", ["--global=true", "alpha"]],
    ["i", ["-g", "alpha"]],
    ["add", ["--global", "alpha"]],
  ])("rejects %s %s", (command, args) => {
    expect(isGlobalInstallRequest(command, args, clean)).toBe(true);
  });

  it.each([
    ["install", ["--no-global", "alpha"]],
    ["install", ["--global=false", "alpha"]],
    ["install", ["alpha"]],
    ["run", ["-g", "alpha"]],
    ["exec", ["--global", "alpha"]],
    ["remove", ["-g", "alpha"]],
  ])("does not treat %s %s as a global install", (command, args) => {
    expect(isGlobalInstallRequest(command, args, clean)).toBe(false);
  });

  it("honors npm_config_global=true as a fail-safe", () => {
    expect(
      isGlobalInstallRequest("install", ["alpha"], {
        npm_config_global: "true",
      }),
    ).toBe(true);
    expect(
      isGlobalInstallRequest("run", ["alpha"], { npm_config_global: "true" }),
    ).toBe(false);
  });
});

describe("dispatch", () => {
  it("prints help when no command is given", () => {
    const result = dispatch(parseArgs([]), { version: VERSION, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: zyrk <command>");
    expect(result.stdout).toContain("install");
    expect(result.stderr).toBe("");
  });

  it("prints the version", () => {
    const result = dispatch(parseArgs(["--version"]), {
      version: VERSION,
      env: {},
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("fails unknown commands with usage and help", () => {
    const result = dispatch(parseArgs(["frobnicate"]), {
      version: VERSION,
      env: {},
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ZYRK_USAGE");
    expect(result.stdout).toContain("Usage: zyrk <command>");
  });

  it("rejects global installs before any work", () => {
    const result = dispatch(parseArgs(["install", "-g", "alpha"]), {
      version: VERSION,
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ZYRK_GLOBAL_INSTALL_UNSUPPORTED");
    expect(result.stderr).toContain("npm install --global");
    expect(result.stdout).toBe("");
  });

  it("reports implemented commands as dispatched via runCli", () => {
    expect(() =>
      dispatch(parseArgs(["update", "alpha"]), {
        version: VERSION,
        env: {},
      }),
    ).toThrow(ZyrkError);
  });

  it("emits the JSON envelope when requested", () => {
    const result = dispatch(parseArgs(["--json", "add", "--global", "alpha"]), {
      version: VERSION,
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      status: "error",
      code: "ZYRK_GLOBAL_INSTALL_UNSUPPORTED",
    });
  });
});

it("accepts help as a successful command without altering delegated help arguments", () => {
  const parsed = parseArgs(["help"]);
  expect(dispatch(parsed, { version: VERSION, env: {} })).toMatchObject({
    exitCode: 0,
    stderr: "",
  });
  expect(parseArgs(["publish", "help"]).help).toBe(false);
});
