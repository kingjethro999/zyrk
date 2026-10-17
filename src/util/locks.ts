import {
  mkdir,
  rmdir,
  link,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import {
  hostname,
  isErrno,
  mkdirp,
  pathExists,
  randomTempName,
} from "./fsx.ts";
import { randomUUID } from "node:crypto";
import { ID_PREFIX } from "./ids.ts";
import { currentProcessIdentity, readProcessStartId } from "./proc.ts";

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
  /** How long to wait for a live owner before failing with ZYRK_PROJECT_LOCKED. */
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
    const unlock = await guard(lockPath, timeoutMs);
    let observed: LockRecord | null;
    try {
      const record = makeRecord(options.name);
      if (await tryCreate(lockPath, record)) {
        return makeHandle(lockPath, record);
      }

      observed = await readLockRecord(lockPath);
      if (observed === null) {
        if (!(await pathExists(lockPath))) continue;
        throw unsafeLockError();
      }
      if (await definitelyDead(observed)) {
        await rm(lockPath);
        continue;
      }
    } finally {
      await unlock();
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
    ownerId: `${ID_PREFIX.lockAttempt}${identity.pid}.${randomUUID()}`,
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
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.name !== "string" ||
      !parsed.ownerId ||
      typeof parsed.hostname !== "string" ||
      !parsed.hostname ||
      (parsed.startId !== null && typeof parsed.startId !== "string") ||
      typeof parsed.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.acquiredAt)) ||
      typeof parsed.heartbeatAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.heartbeatAt)) ||
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

async function definitelyDead(owner: LockRecord): Promise<boolean> {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
  if (owner.startId === null) return false;
  const start = await readProcessStartId(owner.pid);
  return start !== null && start !== owner.startId;
}

/** Non-reclaimed fencing directory: all descriptor mutations use this guard.
 * A crash during this short section requires explicit offline recovery.
 */
async function guard(
  lockPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<() => Promise<void>> {
  const guardPath = `${lockPath}.guard`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(guardPath, { mode: 0o700 });
      return async () => {
        await rmdir(guardPath);
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (Date.now() - started >= timeoutMs) throw unsafeLockError();
      await sleep(POLL_MS);
    }
  }
}

function unsafeLockError(): ZyrkError {
  return new ZyrkError(
    "ZYRK_PROJECT_LOCKED",
    "Cannot verify the existing lock owner.",
    {
      remedy:
        "Stop all zyrk processes using this project or store, then remove the stale lock descriptor and its .guard fencing directory and retry. Automatic pathname reclamation is unsafe.",
    },
  );
}

function makeHandle(lockPath: string, record: LockRecord): LockHandle {
  const ownerId = record.ownerId;
  return {
    record,
    async heartbeat(): Promise<void> {
      const unlock = await guard(lockPath);
      try {
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
      } finally {
        await unlock();
      }
    },
    async release(): Promise<void> {
      const unlock = await guard(lockPath);
      try {
        const current = await readLockRecord(lockPath);
        if (current === null || current.ownerId !== ownerId) {
          throw new LockLostError(lockPath);
        }
        await rm(lockPath, { force: true });
      } finally {
        await unlock();
      }
    },
  };
}

function makeLockedError(
  name: string,
  lockPath: string,
  owner: LockRecord,
  waitedMs: number,
): ZyrkError {
  return new ZyrkError(
    "ZYRK_PROJECT_LOCKED",
    `another zyrk process holds the ${name} lock`,
    {
      detail: {
        lockPath,
        ownerPid: owner.pid,
        ownerHost: owner.hostname,
        holderName: owner.name,
        waitedMs,
      },
      remedy:
        "wait for the other operation to finish; for a stale lock, stop all zyrk processes using this project or store before removing the lock and retrying",
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
