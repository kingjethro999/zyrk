import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";

/**
 * S02 evidence: every managed boundary zyrk writes or reuses through is
 * validated — ownership, real-directory type, and modes — with lstat so a
 * substituted symlink is rejected instead of followed. Nothing is silently
 * repaired: unsafe state fails closed.
 *
 * A real second-account fixture is not available in this environment; the
 * cross-account isolation gate stays unproven and is documented, not
 * claimed.
 */

let root: string;
const scratch: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-layout-"));
  scratch.push(root);
});

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rmrfNoFollow(dir);
  }
});

describe("store boundary validation (S02)", () => {
  it("rejects a group-writable realizations directory", async () => {
    const storeRoot = path.join(root, "store");
    const store = await Store.open({ root: storeRoot, create: true });
    expect(store.initialized).toBe(true);
    await chmod(path.join(storeRoot, "realizations"), 0o777);

    const failure = await Store.open({ root: storeRoot }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ZYRK_STORE_UNSAFE" });
  });

  it("rejects a symlinked internal directory without following it", async () => {
    const storeRoot = path.join(root, "store");
    await Store.open({ root: storeRoot, create: true });
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    const objectsDir = path.join(storeRoot, "objects");
    await rmrfNoFollow(objectsDir);
    await symlink(outside, objectsDir);

    const failure = await Store.open({ root: storeRoot }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ZYRK_STORE_UNSAFE" });
    expect((await lstat(objectsDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(objectsDir)).toBe(outside);
  });

  it("canonicalizes a symlinked store root to one identity", async () => {
    const real = path.join(root, "real-store");
    const link = path.join(root, "linked-store");
    await symlink(real, link, "dir").catch(async () => {
      await mkdir(real, { recursive: true });
      await symlink(real, link);
    });
    const store = await Store.open({ root: link, create: true });
    expect(store.root).toBe(await realpath(link));
    expect(store.root).toBe(await realpath(real));
  });

  it("refuses to initialize over unsafe existing directories instead of repairing them", async () => {
    const storeRoot = path.join(root, "store");
    await mkdir(path.join(storeRoot, "objects"), { recursive: true });
    await chmod(path.join(storeRoot, "objects"), 0o777);

    const failure = await Store.open({ root: storeRoot, create: true }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ZYRK_STORE_UNSAFE" });
    const mode = (await lstat(path.join(storeRoot, "objects"))).mode & 0o777;
    expect(mode).toBe(0o777);
  });

  it("tolerates missing managed directories, recreated on demand", async () => {
    const storeRoot = path.join(root, "store");
    await Store.open({ root: storeRoot, create: true });
    await rmrfNoFollow(path.join(storeRoot, "realizations"));
    const reopened = await Store.open({ root: storeRoot });
    expect(reopened.initialized).toBe(true);
  });
});
