import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";

/**
 * Process identity for locks and leases: PID plus a start-time discriminator,
 * so a recycled PID is not mistaken for the original owner
 * (SPEC 17.4, 19.3.1).
 *
 * Linux exposes start time via /proc/<pid>/stat (field 22). Where that is
 * unavailable, identity falls back to `null` and liveness answers are
 * conservative: a PID that exists is treated as alive.
 */

export type ProcessIdentity = {
  pid: number;
  /** Process start time discriminator, when the platform provides one. */
  startId: string | null;
};

let cachedSelfStartId: string | null | undefined;

export function currentProcessIdentity(): ProcessIdentity {
  if (cachedSelfStartId === undefined) {
    cachedSelfStartId = readStartIdSync(process.pid);
  }
  return { pid: process.pid, startId: cachedSelfStartId };
}

export async function readProcessStartId(pid: number): Promise<string | null> {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return parseStatStartId(text);
  } catch {
    return null;
  }
}

function readStartIdSync(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    return parseStatStartId(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export function parseStatStartId(statText: string): string | null {
  // Format: pid (comm) state ppid ... The comm field may contain spaces and
  // parentheses, so fields are counted from after the last ')'.
  const close = statText.lastIndexOf(")");
  if (close === -1 || close + 2 > statText.length) return null;
  const rest = statText.slice(close + 2).split(" ");
  // rest[0] is field 3 (state); starttime is field 22 -> index 19.
  const starttime = rest[19];
  return starttime === undefined || !/^\d+$/.test(starttime) ? null : starttime;
}

/**
 * Answer "is this process still alive and the same process?".
 *
 * A positive identification requires startId equality when both sides have
 * one. Without a discriminator, existence of the PID is the best available
 * answer and the caller must treat "maybe" conservatively.
 */
export async function isProcessAlive(identity: ProcessIdentity): Promise<boolean> {
  const { pid, startId } = identity;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) {
    return startId === null || startId === currentProcessIdentity().startId;
  }

  const observed = await readProcessStartId(pid);
  if (observed !== null) {
    return startId === null || observed === startId;
  }

  // No /proc available (or process gone): fall back to kill(pid, 0).
  try {
    process.kill(pid, 0);
    return startId === null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: exists but owned by someone else -> alive, cannot verify startId.
    return code === "EPERM" && startId === null;
  }
}
