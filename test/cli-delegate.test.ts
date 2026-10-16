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
 * behavior. nexu interprets nothing after the command token.
 *
 * The fake-npm fixtures are POSIX-only; the Windows platform gate re-covers
 * this scenario there.
 */

const BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/nexu.js",
);

let root: string;
let project: string;
let fakeBin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nexu-delegate-"));
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
    // One argument per line, so values containing spaces stay exact.
    'printf "%s\\n" "$@" > "$NEXU_TEST_NPM_ARGS"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
  const recorderPath = path.join(fakeBin, "npm");
  await writeFile(recorderPath, script);
  await chmod(recorderPath, 0o755);
}

async function recordedArgs(argsPath: string): Promise<string[]> {
  const text = await readFile(argsPath, "utf8");
  return text === "" ? [] : text.slice(0, -1).split("\n");
}

function childEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("NEXU_") &&
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

function runNexu(
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
      const result = await runNexu(
        ["publish", "--tag", "beta", "--access", "public"],
        childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("delegating `nexu publish` to npm");
      expect(await recordedArgs(argsPath)).toEqual([
        "publish",
        "--tag",
        "beta",
        "--access",
        "public",
      ]);
    });

    it("propagates the npm exit code unchanged", async () => {
      await installFakeNpm("3");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runNexu(
        ["dist-tag", "ls", "some-package"],
        childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("delegating `nexu dist-tag` to npm");
      expect(await recordedArgs(argsPath)).toEqual([
        "dist-tag",
        "ls",
        "some-package",
      ]);
    });

    it("forwards flags nexu would otherwise interpret, including -g", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runNexu(
        ["whoami", "--json", "-g"],
        childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
      );

      expect(result.exitCode).toBe(0);
      expect(await recordedArgs(argsPath)).toEqual(["whoami", "--json", "-g"]);
    });

    it("forwards leading protective flags instead of dropping them (S05)", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const forwarded: Array<{ argv: string[]; expected: string[] }> = [
        {
          argv: ["--dry-run", "publish"],
          expected: ["publish", "--dry-run"],
        },
        {
          argv: ["--dry-run", "unpublish", "private-fixture@1.0.0"],
          expected: ["unpublish", "--dry-run", "private-fixture@1.0.0"],
        },
        {
          argv: ["--ignore-scripts", "pack"],
          expected: ["pack", "--ignore-scripts"],
        },
        {
          argv: ["--registry=https://registry.example.invalid", "publish"],
          expected: ["publish", "--registry=https://registry.example.invalid"],
        },
      ];
      for (const { argv, expected } of forwarded) {
        const result = await runNexu(
          argv,
          childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
        );
        expect(result.exitCode).toBe(0);
        expect(await recordedArgs(argsPath)).toEqual(expected);
      }
    });

    it("fails separate-value leading options before spawning anything (S05)", async () => {
      // A bare value before the command is indistinguishable from the
      // command itself without npm's option schema, so nexu fails closed
      // instead of guessing: the remedy teaches the two working spellings.
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      for (const argv of [
        ["--registry", "https://registry.example.invalid", "publish"],
        ["--tag", "my tag", "publish"],
      ]) {
        const before = await recordedArgs(argsPath).catch(() => null);
        const result = await runNexu(
          argv,
          childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("NEXU_USAGE");
        expect(result.stderr).toContain("--flag=value");
        // No npm process launched, and a previous recording is untouched.
        expect(await recordedArgs(argsPath).catch(() => null)).toEqual(before);
      }
    });

    it("keeps nexu --json visible to npm instead of swallowing it", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runNexu(
        ["--json", "whoami"],
        childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
      );
      expect(result.exitCode).toBe(0);
      expect(await recordedArgs(argsPath)).toEqual(["whoami", "--json"]);
    });

    it("passes npm --help through to npm itself", async () => {
      await installFakeNpm("0");
      const argsPath = path.join(root, "npm-args.txt");
      const result = await runNexu(
        ["publish", "--help"],
        childEnv({ NEXU_TEST_NPM_ARGS: argsPath }),
      );
      expect(result.exitCode).toBe(0);
      expect(await recordedArgs(argsPath)).toEqual(["publish", "--help"]);
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
      expect(errOut.join("")).toContain("NEXU_NPM_UNAVAILABLE");
    });

    it("maps a signaled npm to the shell-convention exit code", async () => {
      const script = "#!/bin/sh\nkill -TERM $$\n";
      const recorderPath = path.join(fakeBin, "npm");
      await writeFile(recorderPath, script);
      await chmod(recorderPath, 0o755);
      const result = await runNexu(["ping"], childEnv());

      expect(result.exitCode).toBe(143);
    });
  },
);
