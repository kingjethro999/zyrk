import { constants } from "node:fs";
import { open, rename, rm, stat, chmod, lstat } from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import {
  Digest,
  committedMode,
  objectIdOf,
  type ModeClass,
} from "../util/hash.ts";
import { ensureDirWithMode, fsyncDir, isErrno, mkdirp } from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { Store } from "./layout.ts";

/**
 * Content-addressed object store (SPEC 8.2).
 *
 * Object key = H(scheme || mode class || H(bytes)). Including the mode class
 * means an executable and a non-executable file with identical bytes never
 * share an inode whose permissions could later be changed. Committed objects
 * are normalized read-only (0444/0555); a writable file must never stay
 * hard-linked to an immutable store object (SPEC 11.2).
 */

export type CommittedObject = {
  objectId: string;
  innerDigestHex: string;
  modeClass: ModeClass;
  bytes: number;
};

export function objectPathFor(store: Store, objectId: string): string {
  if (!/^[0-9a-f]{128}$/.test(objectId))
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      "Invalid content object identity.",
      {
        remedy:
          "Repair the affected source using its verified registry archive.",
      },
    );
  return path.join(
    store.paths.objectsDir,
    "sha512",
    objectId.slice(0, 2),
    objectId,
  );
}

/**
 * Commit a verified staged file as an immutable object.
 *
 * The caller has already written and fsynced the staging file and computed
 * the sha512 of its raw bytes. Commit is a rename (or, when the object
 * already exists, reuse plus discard): the loser of any race discards its
 * staging copy rather than duplicating payload.
 */
export async function commitObjectFromStaging(
  store: Store,
  staged: {
    stagingPath: string;
    innerDigestHex: string;
    modeClass: ModeClass;
    bytes: number;
  },
): Promise<CommittedObject> {
  const objectId = objectIdOf(staged.modeClass, staged.innerDigestHex);
  const target = objectPathFor(store, objectId);
  await mkdirp(path.dirname(target));

  const existing = await statOrNull(target);
  if (existing !== null) {
    const check = await verifyObjectPayload(store, {
      objectId,
      innerDigestHex: staged.innerDigestHex,
      modeClass: staged.modeClass,
      bytes: staged.bytes,
    });
    if (!check.ok)
      throw new ZyrkError(
        "ZYRK_STORE_CORRUPT",
        "Existing content object failed verification before commit reuse.",
        {
          detail: { objectId, reason: check.reason },
          remedy:
            "Repair the affected project; corrupt shared inodes must never be edited in place.",
        },
      );
    await rm(staged.stagingPath, { force: true });
    return {
      objectId,
      innerDigestHex: staged.innerDigestHex,
      modeClass: staged.modeClass,
      bytes: staged.bytes,
    };
  }

  try {
    await rename(staged.stagingPath, target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ZyrkError(
        "ZYRK_STORE_CORRUPT",
        `staged object vanished before commit: ${staged.stagingPath}`,
        {
          detail: { stagingPath: staged.stagingPath, objectId },
          remedy:
            "re-run the operation; if it repeats, check for external cleanup of the store staging directory",
          cause: error,
        },
      );
    }
    throw error;
  }

  const mode = committedMode(staged.modeClass);
  await chmod(target, mode);
  await fsyncFileAndDir(target, path.dirname(target));
  return {
    objectId,
    innerDigestHex: staged.innerDigestHex,
    modeClass: staged.modeClass,
    bytes: staged.bytes,
  };
}

/**
 * Full payload verification: recompute the sha512 of the object's bytes and
 * confirm the recorded mode class still holds (SPEC 11.7).
 */
export async function verifyObjectPayload(
  store: Store,
  object: {
    objectId: string;
    innerDigestHex: string;
    modeClass: ModeClass;
    bytes?: number;
  },
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing"
        | "digest-mismatch"
        | "size-mismatch"
        | "mode-mismatch"
        | "type-mismatch";
    }
> {
  const target = objectPathFor(store, object.objectId);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { ok: false, reason: "missing" };
    if (isErrno(error, "ELOOP")) return { ok: false, reason: "type-mismatch" };
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return { ok: false, reason: "type-mismatch" };
    if (object.bytes !== undefined && fileStat.size !== object.bytes) {
      return { ok: false, reason: "size-mismatch" };
    }
    const digest = new Digest();
    const buffer = Buffer.allocUnsafe(1 << 20);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (digest.hex() !== object.innerDigestHex) {
      return { ok: false, reason: "digest-mismatch" };
    }
    const expectedExec = object.modeClass === "exec";
    const actualExec = (fileStat.mode & 0o111) !== 0;
    if (expectedExec !== actualExec || (fileStat.mode & 0o222) !== 0) {
      return { ok: false, reason: "mode-mismatch" };
    }
    return { ok: true };
  } finally {
    await handle.close();
  }
}

/**
 * Move a corrupt object out of the CAS into quarantine, excluding it from
 * reuse (SPEC 19.2, 11.7). The incident record is written by the caller.
 */
export async function quarantineObject(
  store: Store,
  objectId: string,
  incidentId: string,
): Promise<string | null> {
  if (!/^inc(?:1_|-)[a-zA-Z0-9_-]{1,80}$/.test(incidentId))
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      "Invalid quarantine incident identity.",
    );
  await assertObjectStorePath(store, objectId);
  await assertRealStoreDirectory(store.paths.quarantineDir);
  const source = objectPathFor(store, objectId);
  const destDir = path.join(store.paths.quarantineDir, incidentId, "objects");
  await ensureDirWithMode(destDir, 0o700);
  const dest = path.join(destDir, objectId);
  try {
    await rename(source, dest);
    return dest;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

export async function objectExists(
  store: Store,
  objectId: string,
): Promise<boolean> {
  return (await statOrNull(objectPathFor(store, objectId))) !== null;
}

/** Incident id used for quarantine directories; keeps the name schema-checkable. */
export function newIncidentId(): string {
  return `inc1_${randomId("", 16)}`;
}

async function statOrNull(target: string) {
  try {
    return await stat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function fsyncFileAndDir(file: string, dir: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDir(dir);
}

/** Validate ancestor directories before a quarantine rename can affect their children. */
export async function assertRealStoreDirectory(
  directory: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new ZyrkError(
      "ZYRK_STORE_UNSAFE",
      "Store content path passes through a non-directory or symbolic link.",
      {
        remedy:
          "Restore the managed store directory layout before repairing; external filesystem targets are never quarantined.",
      },
    );
}
export async function assertObjectStorePath(
  store: Store,
  objectId: string,
): Promise<void> {
  const object = objectPathFor(store, objectId);
  for (const directory of [
    store.paths.objectsDir,
    path.join(store.paths.objectsDir, "sha512"),
    path.dirname(object),
  ])
    await assertRealStoreDirectory(directory);
}
