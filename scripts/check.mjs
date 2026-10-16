#!/usr/bin/env node
/**
 * Full check: typecheck, then tests. Used by `npm run check`.
 * Runs the repo-local binaries; requires `npm install` to have been run.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const isWindows = process.platform === "win32";
const localBin = (name) =>
  path.join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

const steps = [
  ["typecheck", localBin("tsc"), ["-p", "tsconfig.json"]],
  ["test", localBin("vitest"), ["run"]],
];

for (const [name, command, args] of steps) {
  if (!existsSync(command)) {
    console.error(`check: missing ${command}; run npm install first`);
    process.exit(1);
  }
  console.log(`\n--- zyrk check: ${name} ---`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root });
  if (result.error) {
    console.error(`check: ${name} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  const status = result.signal === null ? (result.status ?? 1) : 1;
  if (status !== 0) {
    process.exit(status);
  }
}
