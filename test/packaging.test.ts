import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, symlink, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
const scratch: string[] = [];
afterEach(async () => {
  for (const p of scratch.splice(0)) await rmrfNoFollow(p);
});
it("runs a distribution containing emitted JS without relying on source TypeScript", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zyrk-artifact-"));
  scratch.push(dir);
  await mkdir(path.join(dir, "bin"));
  await cp(path.resolve("dist"), path.join(dir, "dist"), { recursive: true });
  await cp(path.resolve("bin/zyrk.js"), path.join(dir, "bin/zyrk.js"));
  await cp(path.resolve("package.json"), path.join(dir, "package.json"));
  await symlink(
    path.resolve("node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
  const pkg = JSON.parse(
    await readFile(path.join(dir, "package.json"), "utf8"),
  );
  expect(
    (
      await exec(process.execPath, [path.join(dir, "bin/zyrk.js"), "--version"])
    ).stdout.trim(),
  ).toBe(pkg.version);
  expect(
    (await exec(process.execPath, [path.join(dir, "bin/zyrk.js"), "--help"]))
      .stdout,
  ).toContain("Usage: zyrk");
});
