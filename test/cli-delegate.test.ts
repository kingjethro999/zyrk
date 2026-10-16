import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.ts";
import { isDelegatedCommand } from "../src/cli/npm-delegate.ts";
import { parseArgs } from "../src/cli/parse.ts";

/**
 * D-3 evidence: registry write-side and account commands run the user's own
 * npm with verbatim arguments, a stderr disclosure, and unchanged exit
 * behavior. snpm interprets nothing after the command token.
 *
 * The fake-npm fixtures are POSIX-only; the Windows platform gate re-covers
 * this scenario there.
 */

const BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/snpm.js",
);

let root: string;
let project: string;
let fakeBin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snpm-delegate-"));
  project = path.join(root, "project");
  fakeBin = path.join(root, "bin");
  await mkdir(project, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fake npm: records its argv as JSON, exits with FAKE_NPM_EXIT. */
async function installFakeNpm(exitCode: string): Promise<void> {
  const script = [
    "#!/bin/sh",
    'echo "$@" > "$SNPM_TEST_NPM_ARGS"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
  const recorderPath = path.join(fakeBin, "npm");
  await writeFile(recorderPath, script);
  await chmod(recorderPath, 0o755);
}

function childEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("SNPM_") &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS",
    ),
  ) as NodeJS.ProcessEnv;
  env.PATH = `${fakeBin}${path.delimiter}${env.PATH ?? ""}`;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runSnpm(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: project, env },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown })
            .code;
          if (typeof code === "number")
            resolve({ exitCode: code, stdout, stderr });
          else reject(error);
        } else {
          resolve({ exitCode: 0, stdout, stderr });
        }
      },
    );
  });
}

describe("delegation routing", () => {
  it("covers the documented registry write and account commands", () => {
    for (const command of [
      "publish",
      "unpublish",
      "access",
      "deprecate",
      "dist-tag",
      "owner",
      "token",
      "adduser",
      "login",
      "logout",
      "whoami",
      "ping",
      "pack",
    ]) {
      expect(isDelegatedCommand(command)).toBe(true);
    }
    expect(isDelegatedCommand("install")).toBe(false);
    expect(isDelegatedCommand("frobnicate")).toBe(false);
  });

  it("keeps the raw tail verbatim for npm", () => {
    expect(parseArgs(["publish", "--tag", "beta"]).argsAfterCommand).toEqual([
      "--tag",
      "beta",
    ]);
    expect(parseArgs(["publish", "--json"]).argsAfterCommand).toEqual([
      "--json",
    ]);
    expect(parseArgs(["publish", "--", "--tag"]).argsAfterCommand).toEqual([
      "--",
      "--tag",
    ]);
    expect(
      parseArgs(["--json", "publish", "--tag", "beta"]).argsAfterCommand,
    ).toEqual(["--tag", "beta"]);
    expect(parseArgs(["install", "alpha"]).argsAfterCommand).toEqual(["alpha"]);
    expect(parseArgs([]).argsAfterCommand).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "npm delegation end to end",
  () => {
    it("forwards publish arguments verbatim with a disclosure", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runSnpm(
        ["publish", "--tag", "beta", "--access", "public"],
        childEnv({ SNPM_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("delegating `snpm publish` to npm");
      expect(await readFile(argsPath, "utf8")).toBe(
        "publish --tag beta --access public\n",
      );
    });

    it("propagates the npm exit code unchanged", async () => {
      await installFakeNpm("3");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runSnpm(
        ["dist-tag", "ls", "some-package"],
        childEnv({ SNPM_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("delegating `snpm dist-tag` to npm");
      expect(await readFile(argsPath, "utf8")).toBe(
        "dist-tag ls some-package\n",
      );
    });

    it("forwards flags snpm would otherwise interpret, including -g", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runSnpm(
        ["whoami", "--json", "-g"],
        childEnv({ SNPM_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(0);
      expect(await readFile(argsPath, "utf8")).toBe("whoami --json -g\n");
    });

    it("reports a missing npm instead of failing silently", async () => {
      const out: string[] = [];
      const errOut: string[] = [];
      const code = await runCli({
        argv: ["publish"],
        env: { PATH: fakeBin },
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => errOut.push(chunk) },
        readVersion: () => "9.9.9-test",
      });

      expect(code).toBe(1);
      expect(errOut.join("")).toContain("SNPM_NPM_UNAVAILABLE");
    });

    it("maps a signaled npm to the shell-convention exit code", async () => {
      const script = "#!/bin/sh\nkill -TERM $$\n";
      const recorderPath = path.join(fakeBin, "npm");
      await writeFile(recorderPath, script);
      await chmod(recorderPath, 0o755);
      const result = await runSnpm(["ping"], childEnv());

      expect(result.exitCode).toBe(143);
    });
  },
);
