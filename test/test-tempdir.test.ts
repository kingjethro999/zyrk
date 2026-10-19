import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);

it.skipIf(process.platform === "win32")(
  "canonicalizes an aliased temporary directory before test fixtures are created",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zyrk-test-tempdir-"));
    try {
      const physical = path.join(root, "physical");
      const alias = path.join(root, "alias");
      await mkdir(physical);
      await symlink(physical, alias);
      const script = `
      import { mkdtemp, realpath } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import path from "node:path";
      await import(process.argv[1]);
      const fixture = await mkdtemp(path.join(tmpdir(), "fixture-"));
      console.log(JSON.stringify({ directory: tmpdir(), fixture, canonical: await realpath(fixture) }));
    `;
      const result = await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          new URL("./setup.ts", import.meta.url).href,
        ],
        { env: { ...process.env, TMPDIR: alias } },
      );
      const reported = JSON.parse(result.stdout);
      expect(reported.directory).toBe(await realpath(physical));
      expect(reported.fixture).toBe(reported.canonical);
      // Setup does not rewrite explicitly selected symlink paths.
      expect(await realpath(alias)).toBe(physical);
      expect(alias).not.toBe(reported.directory);
    } finally {
      await rmrfNoFollow(root);
    }
  },
);
