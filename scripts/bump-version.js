/**
 * Commit-time version bump.
 *
 * Runs from `.githooks/pre-commit` for every commit after the bootstrap
 * commit and records the next version in package.json, package-lock.json, and
 * VERSION. Pre-1.0 ladder: 0.0.0 -> 0.0.1 ... 0.0.9 -> 0.1.0, each patch line
 * counts to 9 before the minor moves, 0.599.9 -> 1.0.0, then plain patches.
 * Ported from the ai-toolx bump script (CommonJS); this repository is ESM.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nextVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === 0 && (minor > 599 || patch > 9))
    throw new Error(`Version outside pre-1.0 range: ${version}`);
  if (major === 0 && minor === 0)
    return patch < 9 ? `0.0.${patch + 1}` : "0.1.0";
  if (major === 0) {
    if (minor === 599 && patch === 9) return "1.0.0";
    return patch < 9 ? `0.${minor}.${patch + 1}` : `0.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const packagePath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  pkg.version = nextVersion(pkg.version);
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const lockPath = path.join(root, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.version = pkg.version;
    if (lock.packages?.[""]) lock.packages[""].version = pkg.version;
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, "VERSION"), `v${pkg.version}\n`);
  console.log(`Version bumped to v${pkg.version}`);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
