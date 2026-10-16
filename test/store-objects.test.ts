import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnpmError } from "../src/errors.ts";
import { Store } from "../src/store/layout.ts";
import {
  commitObjectFromStaging,
  objectExists,
  objectPathFor,
  quarantineObject,
  verifyObjectPayload,
} from "../src/store/objects.ts";
import { Digest, objectIdOf } from "../src/util/hash.ts";

let root: string;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snpm-objects-"));
  store = await Store.open({ root, create: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let stageCounter = 0;

async function stage(
  content: string | Buffer,
  mode = 0o644,
): Promise<{ stagingPath: string; innerDigestHex: string; bytes: number }> {
  const dir = path.join(root, "staging", "test");
  await mkdir(dir, { recursive: true });
  stageCounter += 1;
  const file = path.join(dir, `staged-${stageCounter}`);
  await writeFile(file, content, { mode });
  return {
    stagingPath: file,
    innerDigestHex: new Digest().update(content).hex(),
    bytes: Buffer.byteLength(content),
  };
}

describe("commitObjectFromStaging", () => {
  it("commits a new object read-only and consumes the staging file", async () => {
    const staged = await stage("hello object\n");
    const committed = await commitObjectFromStaging(store, {
      ...staged,
      modeClass: "plain",
    });

    expect(committed.objectId).toBe(objectIdOf("plain", staged.innerDigestHex));
    const target = objectPathFor(store, committed.objectId);
    await expect(readFile(target, "utf8")).resolves.toBe("hello object\n");
    expect((await stat(target)).mode & 0o777).toBe(0o444);
    await expect(stat(staged.stagingPath)).rejects.toThrow();
    await expect(objectExists(store, committed.objectId)).resolves.toBe(true);
  });

  it("keeps executable content in a distinct object from plain content", async () => {
    const plain = await stage("#!/bin/sh\necho hi\n");
    const exec = await stage("#!/bin/sh\necho hi\n");
    const plainObject = await commitObjectFromStaging(store, {
      ...plain,
      modeClass: "plain",
    });
    const execObject = await commitObjectFromStaging(store, {
      ...exec,
      modeClass: "exec",
    });

    expect(plainObject.objectId).not.toBe(execObject.objectId);
    expect(
      (await stat(objectPathFor(store, plainObject.objectId))).mode & 0o777,
    ).toBe(0o444);
    expect(
      (await stat(objectPathFor(store, execObject.objectId))).mode & 0o777,
    ).toBe(0o555);
  });

  it("reuses an existing object for identical verified content", async () => {
    const first = await stage("same bytes");
    const second = await stage("same bytes");
    const a = await commitObjectFromStaging(store, {
      ...first,
      modeClass: "plain",
    });
    const b = await commitObjectFromStaging(store, {
      ...second,
      modeClass: "plain",
    });

    expect(b.objectId).toBe(a.objectId);
    // The duplicate staging file is discarded rather than linked twice.
    await expect(stat(second.stagingPath)).rejects.toThrow();
    await expect(verifyObjectPayload(store, a)).resolves.toEqual({ ok: true });
  });

  it("fails loudly when the same object key holds different bytes", async () => {
    const first = await stage("aaaa");
    const committed = await commitObjectFromStaging(store, {
      ...first,
      modeClass: "plain",
    });

    // Claim the first object's digest while staging longer different content.
    const impostor = await stage("aaaaaaaa");
    await expect(
      commitObjectFromStaging(store, {
        stagingPath: impostor.stagingPath,
        innerDigestHex: committed.innerDigestHex,
        modeClass: "plain",
        bytes: impostor.bytes,
      }),
    ).rejects.toMatchObject({ code: "SNPM_STORE_CORRUPT" });
  });
});

describe("verifyObjectPayload", () => {
  it("detects a missing object", async () => {
    const missing = {
      objectId: objectIdOf("plain", "00".repeat(64)),
      innerDigestHex: "00".repeat(64),
      modeClass: "plain" as const,
    };
    await expect(verifyObjectPayload(store, missing)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("detects altered bytes", async () => {
    const staged = await stage("authentic content");
    const committed = await commitObjectFromStaging(store, {
      ...staged,
      modeClass: "plain",
    });
    const target = objectPathFor(store, committed.objectId);

    await chmod(target, 0o644);
    await writeFile(target, "tampered content!!");
    await chmod(target, 0o444);

    await expect(verifyObjectPayload(store, committed)).resolves.toEqual({
      ok: false,
      reason: "size-mismatch",
    });
    await expect(
      verifyObjectPayload(store, {
        objectId: committed.objectId,
        innerDigestHex: committed.innerDigestHex,
        modeClass: "plain",
      }),
    ).resolves.toEqual({ ok: false, reason: "digest-mismatch" });
  });

  it("detects a mode-class change", async () => {
    const staged = await stage("#!/bin/sh\n", 0o755);
    const committed = await commitObjectFromStaging(store, {
      ...staged,
      modeClass: "exec",
    });
    await chmod(objectPathFor(store, committed.objectId), 0o644);
    await expect(verifyObjectPayload(store, committed)).resolves.toEqual({
      ok: false,
      reason: "mode-mismatch",
    });
  });
});

describe("quarantineObject", () => {
  it("moves the object out of the usable store and reports where it went", async () => {
    const staged = await stage("to be quarantined");
    const committed = await commitObjectFromStaging(store, {
      ...staged,
      modeClass: "plain",
    });

    const moved = await quarantineObject(
      store,
      committed.objectId,
      "inc-test-1",
    );
    expect(moved).not.toBeNull();
    await expect(objectExists(store, committed.objectId)).resolves.toBe(false);
    await expect(readFile(moved as string, "utf8")).resolves.toBe(
      "to be quarantined",
    );
    expect(moved as string).toContain(path.join("quarantine", "inc-test-1"));
  });

  it("reports a missing object instead of pretending to quarantine it", async () => {
    await expect(
      quarantineObject(
        store,
        objectIdOf("plain", "11".repeat(64)),
        "inc-test-2",
      ),
    ).resolves.toBeNull();
  });
});

describe("store safety", () => {
  it("refuses a group- or world-writable store root instead of chmodding it", async () => {
    const unsafeRoot = path.join(
      os.tmpdir(),
      `snpm-unsafe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(unsafeRoot, { recursive: true });
    await chmod(unsafeRoot, 0o777);
    try {
      await expect(Store.open({ root: unsafeRoot })).rejects.toMatchObject({
        code: "SNPM_STORE_UNSAFE",
      });
      await expect(
        Store.open({ root: unsafeRoot, create: true }),
      ).rejects.toMatchObject({
        code: "SNPM_STORE_UNSAFE",
      });
      // The refusal must not quietly repair the permissions it objected to.
      expect((await stat(unsafeRoot)).mode & 0o777).toBe(0o777);
    } finally {
      await rm(unsafeRoot, { recursive: true, force: true });
    }
  });

  it("initializes through the explicit unsafe-permissions escape hatch", async () => {
    const unsafeRoot = path.join(
      os.tmpdir(),
      `snpm-unsafe-ok-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(unsafeRoot, { recursive: true });
    await chmod(unsafeRoot, 0o777);
    try {
      const opened = await Store.open({
        root: unsafeRoot,
        create: true,
        allowUnsafePermissions: true,
      });
      expect(opened.initialized).toBe(true);
    } finally {
      await rm(unsafeRoot, { recursive: true, force: true });
    }
  });

  it("reports an uninitialized store without creating one", async () => {
    const absent = path.join(
      os.tmpdir(),
      `snpm-absent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const store = await Store.open({ root: absent });
    expect(store.initialized).toBe(false);
    await expect(stat(absent)).rejects.toThrow();
  });
});
