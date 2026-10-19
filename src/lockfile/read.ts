/**
 * package-lock.json reader: parse once, validate shape, never execute.
 *
 * Absent files are the caller's decision (fresh resolution), so reading a
 * missing path returns null. Anything present but unreadable or misshapen
 * fails loudly: a frozen install must never silently re-resolve.
 */

import { validateWorkspaceLockDoc } from "../install/workspace-lock.ts";
import { assertPortableLockMetadata, lockedGraph } from "../install/lock.ts";
import { readFile } from "node:fs/promises";
import { ZyrkError } from "../errors.ts";
import { isErrno, pathExists } from "../util/fsx.ts";
import {
  ZYRK_LOCK_EXTENSION_VERSION,
  type NpmLockDoc,
  type ZyrkLockExtension,
} from "./types.ts";

export type ReadLockResult = {
  path: string;
  doc: NpmLockDoc;
};

export async function readLockfile(
  lockPath: string,
  allowPlatformRefresh = false,
): Promise<ReadLockResult | null> {
  if (!(await pathExists(lockPath))) return null;
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      `lockfile at ${lockPath} is not valid JSON`,
      {
        detail: { path: lockPath },
        remedy:
          "restore the lockfile from version control or delete it to resolve fresh",
        cause: error,
      },
    );
  }
  if (allowPlatformRefresh && typeof parsed === "object" && parsed !== null) {
    const extension = (parsed as NpmLockDoc).zyrk;
    if (extension?.version === 1 && extension.platformPolicy === undefined) {
      // Validate old metadata without treating a platform-pruned graph as portable.
      const checked = structuredClone(parsed) as NpmLockDoc;
      checked.zyrk!.platformPolicy = "portable-optional/1";
      validateLockDoc(checked, lockPath);
      return { path: lockPath, doc: parsed as NpmLockDoc };
    }
  }
  return { path: lockPath, doc: validateLockDoc(parsed, lockPath) };
}

export function validateLockDoc(doc: unknown, label: string): NpmLockDoc {
  const bad = (why: string): ZyrkError =>
    new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      `lockfile ${label} is malformed (${why})`,
      {
        detail: { path: label },
        remedy:
          "restore the lockfile from version control or delete it to resolve fresh",
      },
    );
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    throw bad("not an object");
  const record = doc as Record<string, unknown>;
  if (
    record["lockfileVersion"] !== undefined &&
    record["lockfileVersion"] !== 1 &&
    record["lockfileVersion"] !== 2 &&
    record["lockfileVersion"] !== 3
  ) {
    throw bad(
      `unsupported lockfileVersion ${String(record["lockfileVersion"])}`,
    );
  }
  if (record["lockfileVersion"] === 1) {
    throw new ZyrkError(
      "ZYRK_MANIFEST_INVALID",
      `lockfile ${label} uses the legacy v1 layout, which zyrk cannot use`,
      {
        detail: { path: label },
        remedy:
          "regenerate the lockfile with a modern npm (lockfileVersion 2 or 3) first",
      },
    );
  }
  if (record["packages"] !== undefined) {
    if (
      typeof record["packages"] !== "object" ||
      record["packages"] === null ||
      Array.isArray(record["packages"])
    ) {
      throw bad("packages is not an object");
    }
    for (const [location, entry] of Object.entries(
      record["packages"] as Record<string, unknown>,
    )) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw bad(`packages entry ${location} is not an object`);
      }
    }
  }
  if ((record["zyrk"] as { version?: unknown } | undefined)?.version === 2) {
    validateWorkspaceLockDoc(doc);
    return doc as NpmLockDoc;
  }
  assertPortableLockMetadata(doc);
  if (record["zyrk"] !== undefined) validateExtension(record["zyrk"], label);
  if (record["zyrk"] !== undefined) lockedGraph(doc as NpmLockDoc);
  return doc as NpmLockDoc;
}

function validateExtension(
  extension: unknown,
  label: string,
): asserts extension is ZyrkLockExtension {
  const bad = (why: string): ZyrkError =>
    new ZyrkError(
      "ZYRK_LOCK_MISMATCH",
      `lockfile ${label} has an unusable zyrk extension (${why})`,
      {
        detail: { path: label },
        remedy: "refresh the lockfile intentionally with zyrk",
      },
    );
  if (
    typeof extension !== "object" ||
    extension === null ||
    Array.isArray(extension)
  ) {
    throw bad("extension is not an object");
  }
  const record = extension as Record<string, unknown>;
  if (record["version"] !== ZYRK_LOCK_EXTENSION_VERSION) {
    throw bad(
      `extension version ${String(record["version"])} is not supported`,
    );
  }
  for (const field of [
    "resolver",
    "manifest",
    "scripts",
    "config",
    "nodes",
    "roots",
  ]) {
    if (record[field] === undefined) throw bad(`extension is missing ${field}`);
  }
  if (typeof record["nodes"] !== "object" || record["nodes"] === null)
    throw bad("nodes is not an object");
  if (typeof record["roots"] !== "object" || record["roots"] === null)
    throw bad("roots is not an object");
}

export type FrozenFingerprints = {
  manifest: string;
  scripts: string;
  config: string;
};

/**
 * Frozen-install compatibility (D-1): the extension must exist, come from a
 * supported writer, and match the current manifests, portable script
 * policy, and resolution configuration. Any disagreement fails with
 * ZYRK_LOCK_MISMATCH; a frozen install never silently re-resolves.
 */
export function assertFrozenCompatible(
  doc: NpmLockDoc,
  expected: FrozenFingerprints,
): void {
  const mismatch = (what: string, remedy: string): ZyrkError =>
    new ZyrkError(
      "ZYRK_LOCK_MISMATCH",
      `frozen lockfile is not compatible (${what})`,
      {
        remedy,
      },
    );
  validateLockDoc(doc, "package-lock.json");
  const extension = doc.zyrk;
  if (extension === undefined) {
    throw mismatch(
      "no zyrk extension",
      "this lockfile was written without zyrk metadata; refresh it intentionally with zyrk",
    );
  }
  if (extension.manifest !== expected.manifest) {
    throw mismatch(
      "manifest fingerprint differs",
      "package.json requirements changed since the lock was written; refresh the lockfile intentionally",
    );
  }
  if (extension.scripts !== expected.scripts) {
    throw mismatch(
      "script-policy fingerprint differs",
      "the portable script policy changed; refresh the lockfile intentionally",
    );
  }
  if (extension.config !== expected.config) {
    throw mismatch(
      "configuration fingerprint differs",
      "resolution-affecting configuration changed; refresh the lockfile intentionally",
    );
  }
}
