import { createReadStream } from "node:fs";
import {
  chmod,
  link as fsLink,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open,
  rm,
  symlink as fsSymlink,
} from "node:fs/promises";
import * as path from "node:path";
import { Parser, type ReadEntry } from "tar";
import { NexuError } from "../errors.ts";
import { Digest, modeClassOf, type ModeClass } from "../util/hash.ts";
import { ensureDirWithMode, isErrno } from "../util/fsx.ts";

/**
 * Safe archive extraction (SPEC 13.4).
 *
 * Two passes over the archive: the first validates every entry (paths,
 * collisions, limits, supported types) and decides how a single common root
 * directory, if any, is stripped; the second writes entries under the
 * transaction's staging directory. The validation pass writes nothing.
 *
 * Rules enforced here:
 * - absolute paths, drive letters, backslashes, NUL bytes, and `..`
 *   traversal are rejected;
 * - case-folding collisions are rejected; Windows-reserved names and
 *   invalid characters are detected and reported (deploy targets re-check);
 * - only regular files, directories, symlinks, and validated hard links are
 *   accepted;
 * - symlink and hard-link targets must stay inside the package root;
 * - setuid/setgid/sticky bits and archive ownership are never applied;
 * - files are created exclusively (`wx`) and never written through a
 *   previously created symlink;
 * - entry count, total bytes, and path lengths are bounded.
 */

export type ExtractionLimits = {
  maxEntries: number;
  maxTotalBytes: number;
  maxPathLength: number;
  maxComponentLength: number;
  maxSymlinkTargetLength: number;
};

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxEntries: 200_000,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxPathLength: 4096,
  maxComponentLength: 255,
  maxSymlinkTargetLength: 4096,
};

export type ExtractedFileEntry = {
  path: string;
  type: "file";
  mode: ModeClass;
  size: number;
  innerDigest: string;
  /** Absolute path inside the staging tree, for the commit step. */
  stagingPath: string;
};

export type ExtractedDirEntry = { path: string; type: "dir" };

export type ExtractedSymlinkEntry = {
  path: string;
  type: "symlink";
  target: string;
};

export type ExtractedEntry =
  ExtractedFileEntry | ExtractedDirEntry | ExtractedSymlinkEntry;

export type ExtractionResult = {
  entries: ExtractedEntry[];
  totals: {
    files: number;
    dirs: number;
    symlinks: number;
    logicalBytes: number;
  };
  /** Deterministic, sorted outcome codes; stored in the source manifest. */
  outcomes: string[];
  /** The stripped common root directory, if one was found. */
  commonRoot: string | null;
  /** Non-fatal observations for CLI warnings. */
  observations: string[];
};

type EntryPlan = {
  index: number;
  rawPath: string;
  effectivePath: string;
  type: "file" | "dir" | "symlink" | "hardlink";
  size: number;
  mode: number;
  linkpath: string | null;
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/;

export async function extractTarball(options: {
  tarballPath: string;
  destDir: string;
  limits?: Partial<ExtractionLimits>;
}): Promise<ExtractionResult> {
  const limits: ExtractionLimits = {
    ...DEFAULT_EXTRACTION_LIMITS,
    ...options.limits,
  };
  await ensureDirWithMode(options.destDir, 0o700);
  const destRoot = path.resolve(options.destDir);

  // ---- Pass 1: validate and plan (writes nothing) ----
  const plans: EntryPlan[] = [];
  const observations: string[] = [];
  let observedReserved = 0;
  let observedWindowsInvalid = 0;

  await runParser(options.tarballPath, async (entry, index) => {
    if (plans.length >= limits.maxEntries) {
      throw unsafe(`archive has more than ${limits.maxEntries} entries`, {
        maxEntries: limits.maxEntries,
      });
    }
    const size = entry.size ?? 0;
    if (size > limits.maxTotalBytes) {
      throw unsafe(
        `archive entry declares ${size} bytes, beyond the limit of ${limits.maxTotalBytes}`,
        {
          entryPath: entry.path,
        },
      );
    }
    const check = normalizeArchivePath(entry.path ?? "", limits);
    if (check.reserved) observedReserved += 1;
    if (check.invalidWindows) observedWindowsInvalid += 1;

    plans.push({
      index,
      rawPath: check.normalized,
      effectivePath: check.normalized,
      type: planType(entry),
      size,
      mode: typeof entry.mode === "number" ? entry.mode : 0o644,
      linkpath:
        typeof entry.linkpath === "string" && entry.linkpath !== ""
          ? entry.linkpath
          : null,
    });
    entry.resume();
  });

  assertNoDuplicateRawPaths(plans);

  // A single wrapping root directory (npm's conventional `package/`) is
  // stripped so manifests and realizations are stable regardless of the
  // publisher's chosen wrapper name.
  const commonRoot = findCommonRoot(plans);
  const finalPlans: EntryPlan[] = [];
  for (const plan of plans) {
    plan.effectivePath =
      commonRoot === null
        ? plan.rawPath
        : stripPrefix(plan.rawPath, commonRoot);
    if (plan.effectivePath !== "") finalPlans.push(plan);
  }

  // Validate effective paths, duplicates, and byte limits.
  const effectiveByPath = new Map<string, EntryPlan>();
  const foldedSeen = new Map<string, string>();
  let totalBytes = 0;
  for (const plan of finalPlans) {
    const check = normalizeArchivePath(plan.effectivePath, limits);
    if (check.normalized !== plan.effectivePath) {
      throw unsafe(
        `entry path changes meaning when normalized: ${plan.rawPath}`,
        { entryPath: plan.rawPath },
      );
    }
    if (effectiveByPath.has(plan.effectivePath)) {
      throw unsafe(
        `archive contains ${JSON.stringify(plan.effectivePath)} more than once`,
        {
          entryPath: plan.effectivePath,
        },
      );
    }
    effectiveByPath.set(plan.effectivePath, plan);

    const folded = casefold(plan.effectivePath);
    const clash = foldedSeen.get(folded);
    if (clash !== undefined) {
      throw unsafe(
        `case-folding collision between ${JSON.stringify(clash)} and ${JSON.stringify(plan.effectivePath)}`,
        {
          pathA: clash,
          pathB: plan.effectivePath,
        },
      );
    }
    foldedSeen.set(folded, plan.effectivePath);

    if (plan.type === "file" || plan.type === "hardlink") {
      totalBytes += plan.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw unsafe(
          `archive expands to more than ${limits.maxTotalBytes} bytes`,
          {
            maxTotalBytes: limits.maxTotalBytes,
          },
        );
      }
    }
  }

  // Resolve hard-link targets against the extracted tree.
  for (const plan of finalPlans) {
    if (plan.type !== "hardlink") continue;
    if (plan.linkpath === null) {
      throw unsafe(`hard link without a target: ${plan.effectivePath}`, {
        entryPath: plan.effectivePath,
      });
    }
    const targetCheck = normalizeArchivePath(plan.linkpath, limits);
    const target =
      commonRoot === null
        ? targetCheck.normalized
        : stripPrefix(targetCheck.normalized, commonRoot);
    const targetPlan = target === "" ? undefined : effectiveByPath.get(target);
    if (targetPlan === undefined || targetPlan.type !== "file") {
      throw unsafe(
        `hard link target is not an extracted regular file: ${plan.effectivePath} -> ${plan.linkpath}`,
        {
          entryPath: plan.effectivePath,
          target: plan.linkpath,
        },
      );
    }
    plan.linkpath = target;
  }

  // Validate symlink targets lexically before writing anything.
  for (const plan of finalPlans) {
    if (plan.type !== "symlink") continue;
    const target = plan.linkpath;
    if (target === null || target === "") {
      throw unsafe(`symlink without a target: ${plan.effectivePath}`, {
        entryPath: plan.effectivePath,
      });
    }
    if (target.length > limits.maxSymlinkTargetLength) {
      throw unsafe(
        `symlink target longer than ${limits.maxSymlinkTargetLength} characters: ${plan.effectivePath}`,
        {
          entryPath: plan.effectivePath,
        },
      );
    }
    if (target.includes("\\")) {
      throw unsafe(
        `symlink target contains a backslash: ${plan.effectivePath}`,
        { entryPath: plan.effectivePath },
      );
    }
    if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
      throw unsafe(`symlink target is absolute: ${plan.effectivePath}`, {
        entryPath: plan.effectivePath,
        target,
      });
    }
    assertTargetStaysInside(plan.effectivePath, target);
  }

  if (observedReserved > 0) {
    observations.push(
      `${observedReserved} path(s) use names reserved on Windows; deployment to Windows requires review`,
    );
  }
  if (observedWindowsInvalid > 0) {
    observations.push(
      `${observedWindowsInvalid} path(s) contain characters invalid on Windows; deployment to Windows requires review`,
    );
  }

  // ---- Pass 2: materialize ----
  const planByIndex = new Map(finalPlans.map((plan) => [plan.index, plan]));
  const symlinks = new Map<string, string>();
  const dirs = new Set<string>();
  const fileEntries = new Map<string, ExtractedFileEntry>();
  const entries: ExtractedEntry[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let symlinkCount = 0;
  let logicalBytes = 0;

  await runParser(options.tarballPath, async (entry, index) => {
    const plan = planByIndex.get(index);
    if (plan === undefined) {
      // Entries removed by common-root stripping still must be drained.
      entry.resume();
      return;
    }

    switch (plan.type) {
      case "dir": {
        await ensureDirsFor(
          rootRelative(destRoot, plan.effectivePath),
          destRoot,
          symlinks,
        );
        dirs.add(plan.effectivePath);
        dirCount += 1;
        entries.push({ path: plan.effectivePath, type: "dir" });
        entry.resume();
        return;
      }
      case "file": {
        await ensureDirsFor(
          rootRelative(destRoot, path.dirname(plan.effectivePath)),
          destRoot,
          symlinks,
        );
        const observed = await writeEntryFile(
          entry,
          destRoot,
          plan.effectivePath,
        );
        if (observed.size !== plan.size) {
          await rm(observed.stagingPath, { force: true }).catch(() => {});
          throw unsafe(
            `file size mismatch while extracting ${plan.effectivePath}`,
            {
              entryPath: plan.effectivePath,
              declared: plan.size,
              actual: observed.size,
            },
          );
        }
        fileCount += 1;
        logicalBytes += observed.size;
        const fileEntry: ExtractedFileEntry = {
          path: plan.effectivePath,
          type: "file",
          mode: observed.mode,
          size: observed.size,
          innerDigest: observed.innerDigest,
          stagingPath: observed.stagingPath,
        };
        fileEntries.set(plan.effectivePath, fileEntry);
        entries.push(fileEntry);
        return;
      }
      case "symlink": {
        const target = plan.linkpath!;
        await ensureDirsFor(
          rootRelative(destRoot, path.dirname(plan.effectivePath)),
          destRoot,
          symlinks,
        );
        await fsSymlink(target, rootRelative(destRoot, plan.effectivePath));
        symlinks.set(plan.effectivePath, target);
        symlinkCount += 1;
        entries.push({ path: plan.effectivePath, type: "symlink", target });
        entry.resume();
        return;
      }
      case "hardlink": {
        const target = plan.linkpath!;
        const targetEntry = fileEntries.get(target);
        if (targetEntry === undefined) {
          throw unsafe(
            `hard link target was not extracted: ${plan.effectivePath} -> ${target}`,
            {
              entryPath: plan.effectivePath,
              target,
            },
          );
        }
        await ensureDirsFor(
          rootRelative(destRoot, path.dirname(plan.effectivePath)),
          destRoot,
          symlinks,
        );
        const dest = rootRelative(destRoot, plan.effectivePath);
        try {
          await fsLink(rootRelative(destRoot, target), dest);
        } catch (error) {
          throw unsafe(`could not create hard link ${plan.effectivePath}`, {
            entryPath: plan.effectivePath,
            errno: (error as NodeJS.ErrnoException).code,
          });
        }
        fileCount += 1;
        logicalBytes += targetEntry.size;
        const fileEntry: ExtractedFileEntry = {
          ...targetEntry,
          path: plan.effectivePath,
          stagingPath: dest,
        };
        fileEntries.set(plan.effectivePath, fileEntry);
        entries.push(fileEntry);
        entry.resume();
        return;
      }
    }
  });

  // Post-pass: chase every symlink chain so escapes through composed links
  // are detected even if each individual link looked safe.
  let dangling = 0;
  let cyclic = 0;
  for (const [linkPath, target] of symlinks) {
    const chased = chaseSymlinkChain(linkPath, target, symlinks);
    if (chased.escaped) {
      throw unsafe(`symlink chain escapes the package root: ${linkPath}`, {
        entryPath: linkPath,
        target,
      });
    }
    if (chased.cyclic) {
      cyclic += 1;
      continue;
    }
    if (
      !fileEntries.has(chased.finalPath) &&
      !dirs.has(chased.finalPath) &&
      !symlinks.has(chased.finalPath)
    ) {
      dangling += 1;
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const outcomes = new Set<string>([
    "traversal-checked",
    "absolute-paths-rejected",
    "case-collisions-rejected",
    "modes-normalized",
    "exclusive-creation",
    "symlink-closure-validated",
  ]);
  if (symlinkCount > 0) outcomes.add("symlinks-present");
  if (finalPlans.some((plan) => plan.type === "hardlink"))
    outcomes.add("hardlinks-present");
  if (dangling > 0) outcomes.add(`internal-dangling-symlinks:${dangling}`);
  if (cyclic > 0) outcomes.add(`cyclic-symlinks:${cyclic}`);
  if (commonRoot !== null) outcomes.add(`common-root-stripped:${commonRoot}`);
  if (observedReserved > 0)
    outcomes.add(`reserved-windows-names:${observedReserved}`);
  if (observedWindowsInvalid > 0)
    outcomes.add(`windows-invalid-characters:${observedWindowsInvalid}`);

  return {
    entries,
    totals: {
      files: fileCount,
      dirs: dirCount,
      symlinks: symlinkCount,
      logicalBytes,
    },
    outcomes: [...outcomes].sort(),
    commonRoot,
    observations,
  };
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

export type PathCheck = {
  normalized: string;
  reserved: boolean;
  invalidWindows: boolean;
};

/** Normalize and validate an archive path; anything that can escape fails. */
export function normalizeArchivePath(
  rawInput: string,
  limits: ExtractionLimits,
): PathCheck {
  const raw = rawInput.replace(/\/+$/, "");
  if (raw === "") {
    throw unsafe("archive contains an entry with an empty path", {
      entryPath: rawInput,
    });
  }
  if (raw.includes("\0")) {
    throw unsafe("path contains a NUL byte", { entryPath: rawInput });
  }
  if (raw.includes("\\")) {
    throw unsafe("path contains a backslash", { entryPath: rawInput });
  }
  if (raw.startsWith("/")) {
    throw unsafe("path is absolute", { entryPath: rawInput });
  }
  if (/^[A-Za-z]:/.test(raw)) {
    throw unsafe("path contains a drive letter", { entryPath: rawInput });
  }

  const segments: string[] = [];
  let reserved = false;
  let invalidWindows = false;
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw unsafe("path traverses upwards with '..'", { entryPath: rawInput });
    }
    if (Buffer.byteLength(segment, "utf8") > limits.maxComponentLength) {
      throw unsafe(
        `path component longer than ${limits.maxComponentLength} bytes`,
        { entryPath: rawInput },
      );
    }
    if (WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment))
      reserved = true;
    if (WINDOWS_INVALID_CHARS.test(segment)) invalidWindows = true;
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw unsafe("path has no usable segments", { entryPath: rawInput });
  }
  const normalized = segments.join("/");
  if (normalized.length > limits.maxPathLength) {
    throw unsafe(`path longer than ${limits.maxPathLength} characters`, {
      entryPath: rawInput,
    });
  }
  return { normalized, reserved, invalidWindows };
}

function assertTargetStaysInside(linkPath: string, target: string): void {
  let level = linkPath.split("/").length - 1;
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      level -= 1;
      if (level < 0) {
        throw unsafe(
          `link target escapes the package root: ${linkPath} -> ${target}`,
          {
            entryPath: linkPath,
            target,
          },
        );
      }
      continue;
    }
    level += 1;
  }
}

function findCommonRoot(plans: EntryPlan[]): string | null {
  let root: string | null = null;
  for (const plan of plans) {
    const first = plan.rawPath.split("/")[0];
    if (first === undefined) return null;
    if (plan.rawPath === first) {
      // An entry that *is* the candidate root must itself be a directory.
      if (plan.type !== "dir") return null;
    }
    if (root === null) root = first;
    else if (root !== first) return null;
  }
  return root;
}

function stripPrefix(entryPath: string, prefix: string): string {
  if (entryPath === prefix) return "";
  if (entryPath.startsWith(`${prefix}/`))
    return entryPath.slice(prefix.length + 1);
  return entryPath;
}

function assertNoDuplicateRawPaths(plans: EntryPlan[]): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.rawPath)) {
      throw unsafe(
        `archive contains ${JSON.stringify(plan.rawPath)} more than once`,
        { entryPath: plan.rawPath },
      );
    }
    seen.add(plan.rawPath);
  }
}

function casefold(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Entry planning and materialization
// ---------------------------------------------------------------------------

function planType(entry: ReadEntry): EntryPlan["type"] {
  switch (entry.type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return "file";
    case "Directory":
    case "GNUDumpDir":
      return "dir";
    case "SymbolicLink":
      return "symlink";
    case "Link":
      return "hardlink";
    default:
      throw unsafe(
        `unsupported archive entry type ${entry.type} at ${entry.path}`,
        {
          entryPath: entry.path,
          entryType: entry.type,
        },
      );
  }
}

/** Root-relative path -> absolute path, rejecting escapes lexically once more. */
function rootRelative(destRoot: string, relative: string): string {
  const resolved = path.resolve(destRoot, relative);
  if (resolved !== destRoot && !resolved.startsWith(`${destRoot}${path.sep}`)) {
    throw unsafe(`path escapes the extraction root: ${relative}`, {
      entryPath: relative,
    });
  }
  return resolved;
}

/**
 * Create the directory chain for an entry. Every ancestor is checked against
 * the set of symlinks created earlier in this extraction, so nothing is ever
 * written through a symlink (SPEC 13.4); directory entries themselves are
 * created exclusively.
 */
async function ensureDirsFor(
  absDir: string,
  destRoot: string,
  symlinks: Map<string, string>,
): Promise<void> {
  if (absDir === destRoot) return;
  const relative = path.relative(destRoot, absDir);
  const segments = relative.split(path.sep);
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    if (symlinks.has(current)) {
      throw unsafe(
        `refusing to write through a symlink directory: ${current}`,
        { entryPath: current },
      );
    }
  }
  try {
    await fsMkdir(absDir, { recursive: true, mode: 0o755 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      if (isErrno(error, "ENOTDIR")) {
        throw unsafe(`an ancestor of ${relative} is not a directory`, {
          entryPath: relative,
        });
      }
      throw error;
    }
  }
  const stat = await fsLstat(absDir);
  if (stat.isSymbolicLink()) {
    throw unsafe(`refusing to use a symlink as a directory: ${relative}`, {
      entryPath: relative,
    });
  }
  if (!stat.isDirectory()) {
    throw unsafe(`an entry collides with an existing file: ${relative}`, {
      entryPath: relative,
    });
  }
}

async function writeEntryFile(
  entry: ReadEntry,
  destRoot: string,
  relative: string,
): Promise<{
  mode: ModeClass;
  size: number;
  innerDigest: string;
  stagingPath: string;
}> {
  const dest = rootRelative(destRoot, relative);
  const declaredMode = typeof entry.mode === "number" ? entry.mode : 0o644;
  const modeClass = modeClassOf(declaredMode);
  const fileMode = modeClass === "exec" ? 0o755 : 0o644;

  // 'wx' never follows an existing symlink; any existing entry is an error.
  let handle;
  try {
    handle = await open(dest, "wx", fileMode);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw unsafe(`refusing to overwrite an existing entry: ${relative}`, {
        entryPath: relative,
      });
    }
    throw error;
  }

  const digest = new Digest();
  let size = 0;
  try {
    for await (const chunk of entry) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      digest.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(dest, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  await chmod(dest, fileMode); // archive modes are advisory; bits are normalized
  return {
    mode: modeClass,
    size,
    innerDigest: digest.hex(),
    stagingPath: dest,
  };
}

// ---------------------------------------------------------------------------
// Symlink chain chasing (defense in depth, bounded)
// ---------------------------------------------------------------------------

const MAX_CHASE_HOPS = 40;

export function chaseSymlinkChain(
  linkPath: string,
  target: string,
  symlinks: Map<string, string>,
): { finalPath: string; escaped: boolean; cyclic: boolean } {
  const out: string[] = [];
  let rest = [...linkPath.split("/").slice(0, -1), ...target.split("/")];
  let hops = 0;

  while (rest.length > 0) {
    const segment = rest.shift()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0)
        return { finalPath: "", escaped: true, cyclic: false };
      out.pop();
      continue;
    }
    out.push(segment);
    const candidate = out.join("/");
    const hopTarget = symlinks.get(candidate);
    if (hopTarget !== undefined) {
      hops += 1;
      if (hops > MAX_CHASE_HOPS) {
        return { finalPath: candidate, escaped: false, cyclic: true };
      }
      out.pop();
      rest = [...hopTarget.split("/"), ...rest];
    }
  }
  return { finalPath: out.join("/"), escaped: false, cyclic: false };
}

// ---------------------------------------------------------------------------
// Parser driver
// ---------------------------------------------------------------------------

/**
 * Run the tar parser over the archive, invoking `handler` for each data
 * entry. Entries are processed strictly serially: the parser does not read
 * the next entry until the handler has finished with (or resumed) the
 * current one, which keeps memory bounded on large archives.
 */
async function runParser(
  tarballPath: string,
  handler: (entry: ReadEntry, index: number) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let index = 0;
    let chain: Promise<void> = Promise.resolve();
    let failed = false;

    const stream = createReadStream(tarballPath);
    const finish = (error?: Error): void => {
      if (error !== undefined) {
        failed = true;
        stream.destroy();
        reject(error);
      } else {
        resolve();
      }
    };

    // tar v7 delivers entries through the `entry` event; each entry starts
    // paused and the handler must resume/consume it, which the parser's flow
    // control (and therefore our bounded memory) depends on.
    const parser = new Parser({
      strict: true,
      maxMetaEntrySize: 1024 * 1024,
      maxDecompressionRatio: 2000,
    });
    parser.on("entry", (entry: ReadEntry) => {
      if (entry.meta === true) {
        entry.resume();
        return;
      }
      const entryIndex = index++;
      chain = chain
        .then(() => {
          if (failed) {
            entry.resume();
            return;
          }
          return handler(entry, entryIndex).catch((error: unknown) => {
            failed = true;
            parser.abort(
              error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
          });
        })
        // Handler failures reach the caller through the parser's error event
        // (abort always emits one); swallowing here only keeps the serial
        // chain from becoming an unhandled rejection after the abort.
        .catch(() => {});
    });

    parser.on("error", (error: Error) => {
      finish(
        error instanceof NexuError
          ? error
          : unsafe(`archive could not be parsed: ${error.message}`, {
              archiveError: error.message,
            }),
      );
    });
    parser.on("end", () => {
      chain.then(() => finish()).catch(() => {});
    });

    stream.on("error", (error: Error) => finish(error));
    stream.pipe(parser);
  });
}

function unsafe(message: string, detail: Record<string, unknown>): NexuError {
  return new NexuError("NEXU_EXTRACTION_UNSAFE", message, {
    detail,
    remedy:
      "review the package contents or report the package; nexu will not extract archives that violate the extraction safety rules",
  });
}
