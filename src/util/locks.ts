import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { NexuError } from "../errors.ts";
import {
  hostname,
  isErrno,
  mkdirp,
  pathExists,
  randomTempName,
} from "./fsx.ts";
import { ID_PREFIX } from "./ids.ts";
import { currentProcessIdentity, isProcessAlive } from "./proc.ts";

/**
 * File-based lock with owner liveness recorded as PID plus a start-time
 * discriminator (SPEC 17.4): locks record process identity and last activity
 * rather than PID alone, and a demonstrably live owner's lock is never
 * reclaimed.
 *
 * The lock file is published by writing a complete record to a private
 * temporary file and hard-linking it into place, so a reader never observes a
 * partially written record.
 */

export type LockRecord = {
  v: 1;
  /** Human-readable subject, e.g. "project mutation". */
  name: string;
  ownerId: string;
  pid: number;
  startId: string | null;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
};

export type LockHandle = {
  readonly record: LockRecord;
  /** Refresh last-activity without changing ownership. */
  heartbeat(): Promise<void>;
  release(): Promise<void>;
};

export type AcquireLockOptions = {
  name: string;
  /** How long to wait for a live owner before failing with NEXU_PROJECT_LOCKED. */
  timeoutMs?: number;
  /** Called once per wait cycle while blocked. */
  onWait?: (owner: LockRecord, waitedMs: number) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 120;

export class LockLostError extends Error {
  constructor(lockPath: string) {
    super(`lock ownership lost: ${lockPath}`);
    this.name = "LockLostError";
  }
}

export async function acquireLock(
  lockPath: string,
  options: AcquireLockOptions,
): Promise<LockHandle> {
  await mkdirp(path.dirname(lockPath));
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (;;) {
    const record = makeRecord(options.name);
    if (await tryCreate(lockPath, record)) {
      return makeHandle(lockPath, record);
    }

    const observed = await readLockRecord(lockPath);
    if (observed === null) {
      // Unreadable or vanished. A vanished file means another process won or
      // released; a corrupt file cannot name a live owner and is reclaimed.
      if (await pathExists(lockPath)) {
        await reclaimIfUnchanged(lockPath, null);
      }
      continue;
    }

    const alive = await isProcessAlive({
      pid: observed.pid,
      startId: observed.startId,
    });
    if (!alive) {
      await reclaimIfUnchanged(lockPath, observed);
      continue;
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      throw makeLockedError(options.name, lockPath, observed, waitedMs);
    }
    options.onWait?.(observed, waitedMs);
    await sleep(POLL_MS + Math.floor(Math.random() * 60));
  }
}

function makeRecord(name: string): LockRecord {
  const identity = currentProcessIdentity();
  const now = new Date().toISOString();
  return {
    v: 1,
    name,
    ownerId: `${ID_PREFIX.lockAttempt}${identity.pid}.${now}`,
    pid: identity.pid,
    startId: identity.startId,
    hostname: hostname(),
    acquiredAt: now,
    heartbeatAt: now,
  };
}

async function tryCreate(
  lockPath: string,
  record: LockRecord,
): Promise<boolean> {
  const temp = randomTempName(path.dirname(lockPath), path.basename(lockPath));
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    await link(temp, lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function readLockRecord(
  lockPath: string,
): Promise<LockRecord | null> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (
      parsed.v !== 1 ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    return {
      v: 1,
      name: typeof parsed.name === "string" ? parsed.name : "unknown",
      ownerId: parsed.ownerId,
      pid: parsed.pid,
      startId: typeof parsed.startId === "string" ? parsed.startId : null,
      hostname:
        typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      heartbeatAt:
        typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Remove a lock whose owner was observed dead (or whose record is corrupt).
 *
 * The file is first moved aside with an atomic rename, then the moved file's
 * record is verified against what was observed. If another process replaced
 * the lock in the window between observation and rename, the moved content
 * will not match and the lock is put back when possible, so a live owner is
 * not silently robbed of its lock.
 */
async function reclaimIfUnchanged(
  lockPath: string,
  observed: LockRecord | null,
): Promise<void> {
  const aside = `${lockPath}.stale-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return; // someone else reclaimed or released
    throw error;
  }

  const moved = await readLockRecord(aside);
  const matches =
    observed === null || (moved !== null && moved.ownerId === observed.ownerId);
  if (!matches) {
    // We moved a lock that is not the one we judged dead: restore it.
    try {
      await link(aside, lockPath);
    } catch {
      // Restore failed (a new lock appeared first). The displaced owner will
      // detect replacement on its next heartbeat or release.
    }
  }
  await rm(aside, { force: true }).catch(() => {});
}

function makeHandle(lockPath: string, record: LockRecord): LockHandle {
  const ownerId = record.ownerId;
  return {
    record,
    async heartbeat(): Promise<void> {
      const current = await readLockRecord(lockPath);
      if (current === null || current.ownerId !== ownerId) {
        throw new LockLostError(lockPath);
      }
      const updated: LockRecord = {
        ...current,
        heartbeatAt: new Date().toISOString(),
      };
      const temp = randomTempName(
        path.dirname(lockPath),
        path.basename(lockPath),
      );
      await writeFile(temp, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
      await rename(temp, lockPath);
    },
    async release(): Promise<void> {
      const current = await readLockRecord(lockPath);
      if (current !== null && current.ownerId !== ownerId) {
        throw new LockLostError(lockPath);
      }
      await rm(lockPath, { force: true });
    },
  };
}

function makeLockedError(
  name: string,
  lockPath: string,
  owner: LockRecord,
  waitedMs: number,
): NexuError {
  return new NexuError(
    "NEXU_PROJECT_LOCKED",
    `another nexu process holds the ${name} lock`,
    {
      detail: {
        lockPath,
        ownerPid: owner.pid,
        ownerHost: owner.hostname,
        holderName: owner.name,
        waitedMs,
      },
      remedy:
        "wait for the other operation to finish; if that process is gone, run `nexu doctor` to reclaim the stale lock",
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
