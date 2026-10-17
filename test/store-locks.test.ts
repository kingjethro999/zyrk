import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-locks-"));
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
    hostname: os.hostname(),
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
      ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
    } finally {
      await holder.release();
    }
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThan(400);
  });

  it("reclaims a same-host lock whose owner process is demonstrably gone", async () => {
    const dead = await reapedProcess();
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify(recordWith({ pid: dead.pid, startId: dead.startId }))}\n`,
      { mode: 0o600 },
    );

    const handle = await acquireLock(lockPath, {
      name: "project mutation",
      timeoutMs: 500,
    });
    expect(handle.record.pid).toBe(process.pid);
    await handle.release();
  });

  it("fails closed for a corrupt lock file", async () => {
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "this is not a lock record\n", { mode: 0o600 });

    await expect(
      acquireLock(lockPath, { name: "project mutation", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
    expect((await stat(lockPath)).size).toBeGreaterThan(0);
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

it("preserves remote-host and unknown-host owner records even with dead PIDs", async () => {
  const dead = await reapedProcess();
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (const hostname of ["remote-host", "unknown"]) {
    const record = recordWith({ ...dead, hostname });
    await writeFile(lockPath, JSON.stringify(record));
    await expect(
      acquireLock(lockPath, { name: "mutation", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
    expect(await readLockRecord(lockPath)).toEqual(record);
  }
});

it("fails closed after a process dies while holding the mutation guard", async () => {
  await mkdir(`${lockPath}.guard`, { recursive: true });
  await expect(
    acquireLock(lockPath, { name: "mutation", timeoutMs: 0 }),
  ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
  expect((await stat(`${lockPath}.guard`)).isDirectory()).toBe(true);
});

it("serializes contenders reclaiming the same dead owner", async () => {
  const dead = await reapedProcess();
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify(recordWith(dead)));
  const contenders = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      acquireLock(lockPath, { name: "mutation", timeoutMs: 200 }),
    ),
  );
  const winners = contenders.filter((value) => value.status === "fulfilled");
  expect(winners).toHaveLength(1);
  for (const winner of winners)
    if (winner.status === "fulfilled") {
      expect((await readLockRecord(lockPath))?.ownerId).toBe(
        winner.value.record.ownerId,
      );
      await winner.value.heartbeat();
      await winner.value.release();
    }
});

it("retains a live child owner, then recovers its descriptor after SIGKILL", async () => {
  const moduleUrl = new URL("../src/util/locks.ts", import.meta.url).href;
  const script = `const {acquireLock} = await import(${JSON.stringify(moduleUrl)}); await acquireLock(process.argv[1], {name: "child"}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, lockPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
  try {
    await expect(
      acquireLock(lockPath, { name: "parent", timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    const owner = await acquireLock(lockPath, {
      name: "parent",
      timeoutMs: 1000,
    });
    expect(owner.record.pid).toBe(process.pid);
    await owner.release();
  } finally {
    child.kill("SIGKILL");
  }
});
