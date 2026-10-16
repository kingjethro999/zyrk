import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomId } from "./ids.ts";

/** lstat-based existence check: a dangling symlink exists. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

export async function mkdirp(target: string, mode?: number): Promise<void> {
  await fs.mkdir(target, {
    recursive: true,
    ...(mode === undefined ? {} : { mode }),
  });
}

/** Create a directory and force its mode explicitly (mkdir is umask-affected). */
export async function ensureDirWithMode(
  target: string,
  mode: number,
): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode });
  if (process.platform !== "win32") {
    await fs.chmod(target, mode);
  }
}

/** Unpredictable, transaction-owned temporary name inside a directory. */
export function randomTempName(dir: string, base: string): string {
  return path.join(dir, `.tmp-${base}-${randomId("", 12)}`);
}

/**
 * Durable atomic write: write to a temporary file in the same directory,
 * fsync it, rename over the target, fsync the directory.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(target);
  await mkdirp(dir);
  const temp = randomTempName(dir, path.basename(target));
  const mode = options.mode ?? 0o644;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, target);
    await fsyncDir(dir);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** fsync a directory so a rename inside it survives a crash (POSIX). */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some filesystems and platforms refuse directory fsync; not fatal.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Recursive removal that never follows symlinks and tolerates read-only
 * content: committed package directories are normalized to 0555, so the walker
 * restores owner write permission on a directory before emptying it. Symlink
 * entries are unlinked, never followed — following one could delete data
 * outside the managed tree (SPEC 19.5).
 */
export async function rmrfNoFollow(target: string): Promise<void> {
  let targetStat: Stats;
  try {
    targetStat = await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!targetStat.isDirectory()) {
    await fs.rm(target, { force: true });
    return;
  }
  await removeDirTree(target);
}

async function removeDirTree(dir: string): Promise<void> {
  await fs.chmod(dir, 0o700);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  for (const name of names) {
    const entry = path.join(dir, name);
    let entryStat: Stats;
    try {
      entryStat = await fs.lstat(entry);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (entryStat.isDirectory()) {
      await removeDirTree(entry);
    } else {
      await fs.rm(entry, { force: true });
    }
  }
  await fs.rmdir(dir);
}

export async function readJsonFile<T = unknown>(target: string): Promise<T> {
  const text = await fs.readFile(target, "utf8");
  return JSON.parse(text) as T;
}

export type FileIdentity = { dev: bigint; ino: bigint };

/** Filesystem identity of a path (device + inode), following symlinks. */
export async function fileIdentity(target: string): Promise<FileIdentity> {
  const stat = await fs.stat(target, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

/** Duplicate content by reflink when the filesystem supports it. */
export async function tryReflink(src: string, dest: string): Promise<boolean> {
  try {
    await fs.copyFile(src, dest, fsConstants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch (error) {
    if (
      isErrno(error, "ENOTSUP") ||
      isErrno(error, "EXDEV") ||
      isErrno(error, "EINVAL") ||
      isErrno(error, "EPERM")
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Copy a file, reporting truthfully whether the bytes were reflinked or
 * fully copied (SPEC 11.2, I-012). `COPYFILE_FICLONE_FORCE` either creates a
 * real reflink or fails, so the returned method is exact rather than hopeful.
 */
export async function copyFileExact(
  src: string,
  dest: string,
): Promise<{ method: "reflink" | "copy" }> {
  try {
    await fs.copyFile(src, dest, fsConstants.COPYFILE_FICLONE_FORCE);
    return { method: "reflink" };
  } catch (error) {
    if (
      isErrno(error, "ENOTSUP") ||
      isErrno(error, "EXDEV") ||
      isErrno(error, "EPERM") ||
      isErrno(error, "EINVAL") ||
      isErrno(error, "ENOSYS")
    ) {
      await fs.copyFile(src, dest);
      return { method: "copy" };
    }
    throw error;
  }
}

/**
 * Capability probes. Hard links, reflinks, and directory symlinks MUST be
 * tested, never inferred from filesystem names (SPEC 7.4).
 */
export type CapabilityProbe = {
  hardlink: boolean;
  reflink: boolean;
  directorySymlink: boolean;
};

export async function probeCapabilities(
  storeDir: string,
  projectDir: string,
): Promise<CapabilityProbe> {
  const probeBase = path.join(storeDir, `.probe-${randomId("", 8)}`);
  await mkdirp(probeBase);
  try {
    return {
      hardlink: await probeHardlink(probeBase, projectDir),
      reflink: await probeReflink(probeBase),
      directorySymlink: await probeDirectorySymlink(probeBase, projectDir),
    };
  } finally {
    await rmrfNoFollow(probeBase);
  }
}

async function probeHardlink(fromDir: string, toDir: string): Promise<boolean> {
  const source = path.join(fromDir, "hardlink-probe");
  const target = path.join(toDir, `.snpm-probe-${randomId("", 8)}`);
  try {
    await fs.writeFile(source, "probe", { mode: 0o600 });
    await fs.link(source, target);
    const sourceStat = await fs.stat(source, { bigint: true });
    const targetStat = await fs.stat(target, { bigint: true });
    return (
      sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino
    );
  } catch {
    return false;
  } finally {
    await fs.rm(source, { force: true }).catch(() => {});
    await fs.rm(target, { force: true }).catch(() => {});
  }
}

async function probeReflink(dir: string): Promise<boolean> {
  const source = path.join(dir, "reflink-probe-src");
  const target = path.join(dir, "reflink-probe-dst");
  try {
    await fs.writeFile(source, "probe");
    await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(source, { force: true }).catch(() => {});
    await fs.rm(target, { force: true }).catch(() => {});
  }
}

async function probeDirectorySymlink(
  fromDir: string,
  toDir: string,
): Promise<boolean> {
  const target = path.join(fromDir, "symlink-probe-target");
  const link = path.join(toDir, `.snpm-probe-link-${randomId("", 8)}`);
  try {
    await fs.mkdir(target);
    await fs.symlink(target, link, "dir");
    const resolved = await fs.realpath(link);
    return resolved === (await fs.realpath(target));
  } catch {
    return false;
  } finally {
    await fs.rm(link, { force: true }).catch(() => {});
    await rmrfNoFollow(target).catch(() => {});
  }
}

export function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown-host";
  }
}
