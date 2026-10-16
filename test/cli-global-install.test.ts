import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A-026 evidence: global-install requests fail with
 * SNPM_GLOBAL_INSTALL_UNSUPPORTED, mutate nothing, and never launch npm.
 *
 * A recording `npm` executable sits on PATH; its absence of output proves no
 * subprocess launched for the requested installation. Project snapshots
 * before and after prove no filesystem mutation. The fixture shell script is
 * POSIX-only; the Windows platform gate re-covers this scenario there.
 */

const BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../bin/snpm.js",
);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let root: string;
let project: string;
let fakeBin: string;
let npmLog: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snpm-cli-"));
  project = path.join(root, "project");
  fakeBin = path.join(root, "bin");
  await mkdir(project, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  npmLog = path.join(root, "npm-launches.log");
  const recorder = `#!/bin/sh\necho "npm launched: $@" >> "$SNPM_TEST_NPM_LOG"\nexit 0\n`;
  const recorderPath = path.join(fakeBin, "npm");
  await writeFile(recorderPath, recorder);
  await chmod(recorderPath, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function childEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("SNPM_") &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS" &&
        key !== "npm_config_global",
    ),
  ) as NodeJS.ProcessEnv;
  env.PATH = `${fakeBin}${path.delimiter}${env.PATH ?? ""}`;
  env.SNPM_TEST_NPM_LOG = npmLog;
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

async function snapshot(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const names = [...(await readdir(current))].sort();
    for (const name of names) {
      const full = path.join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stat = await lstat(full);
      entries.push(
        `${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"} ${rel}`,
      );
      if (stat.isDirectory()) await walk(full, rel);
    }
  };
  await walk(dir, "");
  return entries;
}

async function npmLaunched(): Promise<boolean> {
  try {
    await readFile(npmLog, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")(
  "global-install rejection (A-026)",
  () => {
    const cases: string[][] = [
      ["i", "-g", "some-package"],
      ["install", "--global", "some-package"],
      ["add", "-g", "some-package"],
      ["-g", "install", "some-package"],
      ["install", "--global=true", "some-package"],
    ];

    it.each(cases)(
      "snpm %s is rejected without launching npm",
      async (...args) => {
        const before = await snapshot(project);
        const result = await runSnpm(args, childEnv());

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("SNPM_GLOBAL_INSTALL_UNSUPPORTED");
        expect(result.stderr).toContain("npm install --global");
        expect(await npmLaunched()).toBe(false);
        expect(await snapshot(project)).toEqual(before);
      },
    );

    it("rejects npm_config_global=true from the environment", async () => {
      const before = await snapshot(project);
      const result = await runSnpm(
        ["install", "some-package"],
        childEnv({ npm_config_global: "true" }),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("SNPM_GLOBAL_INSTALL_UNSUPPORTED");
      expect(await npmLaunched()).toBe(false);
      expect(await snapshot(project)).toEqual(before);
    });

    it("reports the same code through the JSON envelope", async () => {
      const before = await snapshot(project);
      const result = await runSnpm(
        ["--json", "install", "-g", "some-package"],
        childEnv(),
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        status: "error",
        code: "SNPM_GLOBAL_INSTALL_UNSUPPORTED",
      });
      expect(await npmLaunched()).toBe(false);
      expect(await snapshot(project)).toEqual(before);
    });

    it("does not reject explicit local selections", async () => {
      for (const args of [
        ["install", "--no-global", "some-package"],
        ["install", "--global=false", "some-package"],
      ]) {
        const result = await runSnpm(args, childEnv());
        expect(result.stderr).toContain("SNPM_NOT_IMPLEMENTED");
        expect(result.stderr).not.toContain("SNPM_GLOBAL_INSTALL_UNSUPPORTED");
      }
      expect(await npmLaunched()).toBe(false);
    });

    it("leaves the plain local install to the honest not-implemented path", async () => {
      const result = await runSnpm(["install", "some-package"], childEnv());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("SNPM_NOT_IMPLEMENTED");
      expect(await npmLaunched()).toBe(false);
    });
  },
);

describe("basic CLI behavior", () => {
  it("prints help with no command", async () => {
    const result = await runSnpm([], childEnv());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: snpm <command>");
  });

  it("prints the recorded version", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    const result = await runSnpm(["--version"], childEnv());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("fails unknown commands with help", async () => {
    const result = await runSnpm(["frobnicate"], childEnv());
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SNPM_USAGE");
    expect(result.stdout).toContain("Usage: snpm <command>");
    expect(await npmLaunched()).toBe(false);
  });
});
