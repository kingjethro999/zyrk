import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NexuError } from "../errors.ts";
import { resolveStoreRoot } from "../config/paths.ts";
import {
  ensureDirWithMode,
  isErrno,
  pathExists,
  readJsonFile,
  writeFileAtomic,
} from "../util/fsx.ts";
import {
  CLI_VERSION,
  CONTEXT_CANONICALIZATION_VERSION,
  EXTRACTION_POLICY_VERSION,
  OBJECT_KEY_SCHEME,
  SOURCE_MANIFEST_SCHEMA_VERSION,
  STORE_FORMAT_FILE,
  STORE_FORMAT_VERSION,
} from "../version.ts";

/**
 * The managed store: one verified package store per OS user (SPEC 7).
 *
 * Layout follows SPEC 7.3. Path length is bounded because every
 * content-derived directory name is a fixed-length digest-based identifier
 * and package names never become path components.
 */

export type StorePaths = {
  root: string;
  formatFile: string;
  objectsDir: string;
  sourcesDir: string;
  realizationsDir: string;
  graphsDir: string;
  metadataDir: string;
  journalDir: string;
  locksDir: string;
  stagingDir: string;
  quarantineDir: string;
  trashDir: string;
  pinsDir: string;
  dbFile: string;
};

export function storePaths(root: string): StorePaths {
  const metadataDir = path.join(root, "metadata");
  return {
    root,
    formatFile: path.join(root, STORE_FORMAT_FILE),
    objectsDir: path.join(root, "objects"),
    sourcesDir: path.join(root, "sources"),
    realizationsDir: path.join(root, "realizations"),
    graphsDir: path.join(root, "graphs"),
    metadataDir,
    journalDir: path.join(metadataDir, "journal"),
    locksDir: path.join(root, "locks"),
    stagingDir: path.join(root, "staging"),
    quarantineDir: path.join(root, "quarantine"),
    trashDir: path.join(root, "trash"),
    pinsDir: path.join(root, "pins"),
    dbFile: path.join(metadataDir, "state.sqlite"),
  };
}

export type StoreFormatMarker = {
  storeFormatVersion: number;
  objectKeyScheme: string;
  sourceManifestSchemaVersion: number;
  extractionPolicyVersion: number;
  contextCanonicalizationVersion: number;
  createdAt: string;
  tool: { name: string; version: string };
};

export type OpenStoreOptions = {
  /** Explicit root; defaults to the platform location or NEXU_STORE_DIR. */
  root?: string;
  /** Create and initialize the store if it does not exist. */
  create?: boolean;
  /**
   * Test-only escape hatch for permission checks. Normal operation must never
   * pass this: a group/world-writable store is a blocking diagnostic
   * (SPEC 7.2).
   */
  allowUnsafePermissions?: boolean;
};

export class Store {
  readonly root: string;
  readonly paths: StorePaths;
  /** undefined when the store has not been initialized yet. */
  readonly format: StoreFormatMarker | undefined;

  private constructor(root: string, format: StoreFormatMarker | undefined) {
    this.root = root;
    this.paths = storePaths(root);
    this.format = format;
  }

  get initialized(): boolean {
    return this.format !== undefined;
  }

  static async find(options: { root?: string } = {}): Promise<string> {
    return options.root ?? resolveStoreRoot().root;
  }

  static async open(options: OpenStoreOptions = {}): Promise<Store> {
    const root = await canonicalizeRoot(
      path.resolve(options.root ?? resolveStoreRoot().root),
    );
    const exists = await pathExists(root);
    if (!exists) {
      if (options.create !== true) {
        return new Store(root, undefined);
      }
      await Store.initialize(root, options.allowUnsafePermissions === true);
    } else {
      await Store.checkSafety(root, options.allowUnsafePermissions === true);
    }

    const paths = storePaths(root);
    const markerPath = paths.formatFile;
    if (!(await pathExists(markerPath))) {
      if (options.create === true) {
        await Store.initialize(root, options.allowUnsafePermissions === true);
      } else {
        return new Store(root, undefined);
      }
    }

    const marker = await readStoreFormatMarker(markerPath);
    validateStoreFormatMarker(marker, markerPath);
    return new Store(root, marker);
  }

  /** Throw unless the store is initialized and usable. */
  requireInitialized(): StoreFormatMarker {
    if (this.format === undefined) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `the nexu store at ${this.root} is not initialized`,
        {
          detail: { storeRoot: this.root },
          remedy:
            "run an install or fetch command to initialize the store, or set NEXU_STORE_DIR to an existing initialized store",
        },
      );
    }
    return this.format;
  }

  private static async initialize(
    root: string,
    allowUnsafePermissions: boolean,
  ): Promise<void> {
    if (!(await pathExists(root))) {
      await ensureDirWithMode(root, 0o700);
    }
    // An existing directory is checked, never silently chmodded: quietly
    // changing the permissions of a directory the user pointed at (a home
    // directory, a shared mount) is worse than refusing with a diagnostic
    // (SPEC 7.2).
    await Store.checkSafety(root, allowUnsafePermissions);

    const paths = storePaths(root);
    for (const dir of [
      paths.objectsDir,
      paths.sourcesDir,
      paths.realizationsDir,
      paths.graphsDir,
      paths.metadataDir,
      paths.journalDir,
      paths.locksDir,
      paths.stagingDir,
      paths.quarantineDir,
      paths.trashDir,
      paths.pinsDir,
    ]) {
      await ensureDirWithMode(dir, 0o700);
    }

    if (!(await pathExists(paths.formatFile))) {
      const marker: StoreFormatMarker = {
        storeFormatVersion: STORE_FORMAT_VERSION,
        objectKeyScheme: OBJECT_KEY_SCHEME,
        sourceManifestSchemaVersion: SOURCE_MANIFEST_SCHEMA_VERSION,
        extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
        contextCanonicalizationVersion: CONTEXT_CANONICALIZATION_VERSION,
        createdAt: new Date().toISOString(),
        tool: { name: "nexu", version: CLI_VERSION },
      };
      await writeFileAtomic(
        paths.formatFile,
        `${JSON.stringify(marker, null, 2)}\n`,
        { mode: 0o644 },
      );
    }
  }

  /**
   * Blocking diagnostics for account isolation (SPEC 7.2): the store must be
   * user-owned and not group/world writable. Never fixes ownership
   * automatically; a root-owned store gets a repair explanation instead.
   */
  private static async checkSafety(
    root: string,
    allowUnsafePermissions: boolean,
  ): Promise<void> {
    const resolved = await fs.realpath(root);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store path is not a directory: ${root}`,
        {
          detail: { storeRoot: root },
          remedy:
            "choose a directory for the store, or remove the conflicting file",
        },
      );
    }

    if (process.platform === "win32") {
      // Windows ACL verification arrives with Windows platform support
      // (SPEC 27); until then the store is not advertised as supported there.
      throw new NexuError(
        "NEXU_PLATFORM_UNSUPPORTED",
        "Windows store permission checks are not implemented yet",
        {
          detail: { storeRoot: root, platform: process.platform },
          remedy:
            "run on Linux for now; Windows support is gated on its platform fixtures",
        },
      );
    }

    if (allowUnsafePermissions) return;

    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store is owned by another user (uid ${stat.uid}, running as ${uid}): ${root}`,
        {
          detail: { storeRoot: root, ownerUid: stat.uid, runningUid: uid },
          remedy:
            "if this store was created by root, move it under your own account or point NEXU_STORE_DIR at a user-owned location; nexu never rewrites ownership recursively",
        },
      );
    }
    if (uid !== undefined && stat.uid === 0 && uid !== 0) {
      throw new NexuError("NEXU_STORE_UNSAFE", `store is root-owned: ${root}`, {
        detail: { storeRoot: root, ownerUid: stat.uid },
        remedy:
          "create a fresh store under your account instead of reusing a root-owned one",
      });
    }

    const mode = stat.mode & 0o777;
    if ((mode & 0o022) !== 0) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store is group- or world-writable (mode ${mode.toString(8)}): ${root}`,
        {
          detail: { storeRoot: root, mode: mode.toString(8) },
          remedy: `chmod go-w '${root}' (and its subdirectories) so other accounts cannot modify shared package content`,
        },
      );
    }

    // Every managed boundary nexu writes or reuses through gets the same
    // ownership, type, and mode checks as the root, evaluated with lstat so
    // a substituted symlink is rejected instead of followed (S02). Missing
    // directories are created on demand with 0700; existing ones are never
    // silently repaired.
    const paths = storePaths(resolved);
    for (const dir of [
      paths.objectsDir,
      paths.sourcesDir,
      paths.realizationsDir,
      paths.graphsDir,
      paths.metadataDir,
      paths.journalDir,
      paths.locksDir,
      paths.stagingDir,
      paths.quarantineDir,
      paths.trashDir,
      paths.pinsDir,
    ]) {
      await Store.checkManagedDir(dir, uid, allowUnsafePermissions);
    }
  }

  private static async checkManagedDir(
    dir: string,
    uid: number | undefined,
    allowUnsafePermissions: boolean,
  ): Promise<void> {
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store directory is not a real directory: ${dir}`,
        {
          detail: { storeDir: dir },
          remedy:
            "remove the unexpected file or link and let nexu recreate the managed directory",
        },
      );
    }
    if (allowUnsafePermissions) return;
    if (uid !== undefined && stat.uid !== uid) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store directory is owned by another user (uid ${stat.uid}, running as ${uid}): ${dir}`,
        {
          detail: { storeDir: dir, ownerUid: stat.uid, runningUid: uid },
          remedy:
            "nexu never rewrites ownership recursively; use a store your account owns",
        },
      );
    }
    if ((stat.mode & 0o777 & 0o022) !== 0) {
      throw new NexuError(
        "NEXU_STORE_UNSAFE",
        `store directory is group- or world-writable (mode ${(stat.mode & 0o777).toString(8)}): ${dir}`,
        {
          detail: { storeDir: dir, mode: (stat.mode & 0o777).toString(8) },
          remedy: `chmod go-w '${dir}' so other accounts cannot modify shared package content`,
        },
      );
    }
  }
}

/**
 * Resolve symlinks deliberately so the store has one canonical identity
 * for safety checks, paths, and records. A symlinked NEXU_STORE_DIR is
 * allowed; it always means its target. Missing leaves resolve through
 * their nearest existing ancestor.
 */
async function canonicalizeRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    // A dangling root symlink exists according to lstat but not realpath.
    // Resolve its target before initialization so writes and safety checks
    // use the same canonical directory as an already-existing root.
    try {
      if ((await fs.lstat(root)).isSymbolicLink()) {
        return await canonicalizeRoot(
          path.resolve(path.dirname(root), await fs.readlink(root)),
        );
      }
    } catch (linkError) {
      if (!isErrno(linkError, "ENOENT")) throw linkError;
    }
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return path.join(await canonicalizeRoot(parent), path.basename(root));
  }
}

async function readStoreFormatMarker(
  markerPath: string,
): Promise<StoreFormatMarker> {
  try {
    return await readJsonFile<StoreFormatMarker>(markerPath);
  } catch (error) {
    throw new NexuError(
      "NEXU_STORE_CORRUPT",
      `store format marker is unreadable: ${markerPath}`,
      {
        detail: { formatFile: markerPath },
        remedy:
          "inspect the marker file; if it is damaged, remove it and re-run an install to reinitialize format metadata",
        cause: error,
      },
    );
  }
}

function validateStoreFormatMarker(
  marker: StoreFormatMarker,
  markerPath: string,
): void {
  if (marker.storeFormatVersion !== STORE_FORMAT_VERSION) {
    throw new NexuError(
      "NEXU_STORE_FORMAT_UNSUPPORTED",
      `store format ${marker.storeFormatVersion} is not supported by this nexu (expects ${STORE_FORMAT_VERSION})`,
      {
        detail: {
          formatFile: markerPath,
          storeFormatVersion: marker.storeFormatVersion,
          supported: STORE_FORMAT_VERSION,
        },
        remedy:
          "use a CLI matching this store format, or initialize a fresh store at a new location; if this store is newer, upgrade nexu first",
      },
    );
  }
  if (marker.objectKeyScheme !== OBJECT_KEY_SCHEME) {
    throw new NexuError(
      "NEXU_STORE_FORMAT_UNSUPPORTED",
      `object key scheme ${marker.objectKeyScheme} is not supported`,
      {
        detail: {
          formatFile: markerPath,
          objectKeyScheme: marker.objectKeyScheme,
        },
        remedy:
          "use a CLI that understands this store, or initialize a fresh store",
      },
    );
  }
  if (marker.extractionPolicyVersion !== EXTRACTION_POLICY_VERSION) {
    // Extraction-rule changes are part of source identity (SPEC 8.1/13.4):
    // existing manifests stay readable, but new fetches mint new identities.
    // This is an informational condition, not an error.
  }
}
