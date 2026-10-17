import { constants as osConstants } from "node:os";
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
 * Shell-convention exit code for a finished child process: its exit code,
 * or 128 plus the signal number when it was signaled, so callers observe
 * the same termination through a plain number.
 */
export function closeCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (signal !== null) {
    const number: unknown = osConstants.signals[signal];
    return 128 + (typeof number === "number" ? number : 0);
  }
  return code ?? 1;
}

/**
 * Answer "is this process still alive and the same process?".
 *
 * A positive identification requires startId equality when both sides have
 * one. Without a discriminator, existence of the PID is the best available
 * answer and the caller must treat "maybe" conservatively.
 */
export async function isProcessAlive(
  identity: ProcessIdentity,
): Promise<boolean> {
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

/** Supervise one POSIX process group through targeted wrapper cancellation.
 * Descendants which deliberately detach cannot be controlled by this helper.
 * After 1500 ms cancellation escalates to SIGKILL; listeners are always removed.
 */
export async function superviseChild(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    capture?: boolean;
    escalationMs?: number;
    stdout?: { write(chunk: string): unknown };
    stderr?: { write(chunk: string): unknown };
    onSpawn?: (pid: number, startId: string | null) => void;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: [
        options.capture === true ? "pipe" : "inherit",
        options.capture === true || options.stdout !== undefined
          ? "pipe"
          : "inherit",
        options.capture === true || options.stderr !== undefined
          ? "pipe"
          : "inherit",
      ],
      detached: grouped,
    });
    let startupFailure: Error | undefined;
    let stdout = "";
    let stderr = "";
    let cancelled: NodeJS.Signals | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const send = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(grouped ? -child.pid : child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill(signal);
      }
    };
    const cancel = (signal: NodeJS.Signals): void => {
      if (cancelled !== null) {
        send("SIGKILL");
        return;
      }
      cancelled = signal;
      send(signal);
      escalation = setTimeout(
        () => send("SIGKILL"),
        options.escalationMs ?? 1500,
      );
    };
    const term = (): void => cancel("SIGTERM");
    const interrupt = (): void => cancel("SIGINT");
    const hangup = (): void => cancel("SIGHUP");
    const cleanup = (): void => {
      if (escalation !== undefined) clearTimeout(escalation);
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);
      process.off("SIGHUP", hangup);
    };
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
    process.on("SIGHUP", hangup);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.capture === true) stdout += chunk.toString();
      options.stdout?.write(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (options.capture === true) stderr += chunk.toString();
      options.stderr?.write(chunk.toString());
    });
    child.once("spawn", () => {
      if (child.pid === undefined) return;
      try {
        options.onSpawn?.(child.pid, readStartIdSync(child.pid));
      } catch (error) {
        startupFailure =
          error instanceof Error ? error : new Error(String(error));
        send("SIGKILL");
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      // Kill lingering members before callers remove the temporary environment.
      if (cancelled !== null) send("SIGKILL");
      cleanup();
      if (startupFailure !== undefined) {
        reject(startupFailure);
        return;
      }
      resolve({
        exitCode:
          cancelled === null
            ? closeCode(code, signal)
            : closeCode(null, cancelled),
        stdout,
        stderr,
      });
    });
  });
}
