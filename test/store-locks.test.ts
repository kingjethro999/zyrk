import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LockLostError,
  acquireLock,
  readLockRecord,
  type LockRecord,
} from "../src/util/locks.ts";
import { readProcessStartId } from "../src/util/proc.ts";

let root: string;
let lockPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nexu-locks-"));
  lockPath = path.join(root, "locks", "project.lock");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordWith(
  overrides: Partial<LockRecord> & { pid: number },
): LockRecord {
  return {
    v: 1,
    name: "project mutation",
    ownerId: "lock-attempt-synthetic-owner",
    startId: null,
    hostname: "test-host",
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Spawn a child, capture its PID and start-time discriminator while it is
 * alive, then reap it. Using the child's real startId makes the liveness
 * verdict deterministic even in the unlikely event of PID reuse.
 */
async function reapedProcess(): Promise<{
  pid: number;
  startId: string | null;
}> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn returned no pid");

  let startId: string | null = null;
  for (let attempt = 0; attempt < 100 && startId === null; attempt += 1) {
    startId = await readProcessStartId(pid);
    if (startId === null) await sleep(5);
  }

  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
  return { pid, startId };
}

describe("acquireLock", () => {
  it("publishes a private owner record and removes it on release", async () => {
    const handle = await acquireLock(lockPath, { name: "project mutation" });
    const record = await readLockRecord(lockPath);
    expect(record).toMatchObject({
      name: "project mutation",
      pid: process.pid,
      ownerId: handle.record.ownerId,
    });
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await handle.release();
    await expect(readLockRecord(lockPath)).resolves.toBeNull();
  });

  it("blocks while a demonstrably live owner holds the lock and never reclaims it", async () => {
    const holder = await acquireLock(lockPath, { name: "project mutation" });
    const waits: number[] = [];
    try {
      await expect(
        acquireLock(lockPath, {
          name: "project mutation",
          timeoutMs: 400,
          onWait: (_owner, waitedMs) => waits.push(waitedMs),
        }),
      ).rejects.toMatchObject({ code: "NEXU_PROJECT_LOCKED" });
    } finally {
      await holder.release();
    }
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThan(400);
  });

  it("reclaims a lock whose owner process is gone", async () => {
    const dead = await reapedProcess();
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify(recordWith({ pid: dead.pid, startId: dead.startId }))}\n`,
      { mode: 0o600 },
    );

    const handle = await acquireLock(lockPath, {
      name: "project mutation",
      timeoutMs: 2000,
    });
    expect(handle.record.pid).toBe(process.pid);
    await handle.release();

    const leftovers = (await readdir(path.dirname(lockPath))).filter((name) =>
      name.includes(".stale-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("reclaims an unreadable lock file", async () => {
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "this is not a lock record\n", { mode: 0o600 });

    const handle = await acquireLock(lockPath, {
      name: "project mutation",
      timeoutMs: 2000,
    });
    expect(handle.record.pid).toBe(process.pid);
    await handle.release();
  });
});

describe("heartbeat and release", () => {
  it("refreshes activity while the owner keeps the lock", async () => {
    const handle = await acquireLock(lockPath, { name: "project mutation" });
    try {
      await sleep(20);
      await handle.heartbeat();
      const after = await readLockRecord(lockPath);
      expect(after?.ownerId).toBe(handle.record.ownerId);
      expect(after?.heartbeatAt).not.toBe(handle.record.heartbeatAt);
    } finally {
      await handle.release();
    }
  });

  it("fails loudly once another process replaces the lock", async () => {
    const handle = await acquireLock(lockPath, { name: "project mutation" });
    await rm(lockPath, { force: true });
    await writeFile(
      lockPath,
      `${JSON.stringify(recordWith({ pid: process.pid, ownerId: "lock-attempt-thief" }))}\n`,
      { mode: 0o600 },
    );

    await expect(handle.heartbeat()).rejects.toBeInstanceOf(LockLostError);
    await expect(handle.release()).rejects.toBeInstanceOf(LockLostError);
    // The thief's lock must survive the failed release.
    await expect(readLockRecord(lockPath)).resolves.toMatchObject({
      ownerId: "lock-attempt-thief",
    });
  });
});
