import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snpm-fsx-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pathExists", () => {
  it("reports a dangling symlink as existing (lstat semantics)", async () => {
    const link = path.join(root, "dangling");
    await symlink(path.join(root, "missing-target"), link);
    expect(await pathExists(link)).toBe(true);
  });

  it("reports a missing path as absent", async () => {
    expect(await pathExists(path.join(root, "nope"))).toBe(false);
  });
});

describe("rmrfNoFollow", () => {
  it("removes a tree whose directories were normalized read-only", async () => {
    const tree = path.join(root, "tree");
    const pkg = path.join(tree, "node_modules", "pkg");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "index.js"), "x\n", { mode: 0o444 });
    await chmod(pkg, 0o555);
    await chmod(path.join(tree, "node_modules"), 0o555);

    await rmrfNoFollow(tree);

    expect(await pathExists(tree)).toBe(false);
  });

  it("unlinks a symlink instead of deleting through it", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    const tree = path.join(root, "tree");
    await mkdir(tree, { recursive: true });
    await symlink(outside, path.join(tree, "link"));

    await rmrfNoFollow(tree);

    expect(await pathExists(tree)).toBe(false);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("removes a plain file target", async () => {
    const file = path.join(root, "file.txt");
    await writeFile(file, "x\n");
    await rmrfNoFollow(file);
    expect(await pathExists(file)).toBe(false);
  });

  it("is a no-op for a path that does not exist", async () => {
    await expect(rmrfNoFollow(path.join(root, "ghost"))).resolves.toBeUndefined();
  });
});
