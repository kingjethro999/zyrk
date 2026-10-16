import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { manifestHashOf, type ModeClass } from "../util/hash.ts";
import { pathExists, writeFileAtomic } from "../util/fsx.ts";
import { SOURCE_MANIFEST_SCHEMA_VERSION } from "../version.ts";
import { Store } from "./layout.ts";

/**
 * Source manifests (SPEC 8.3): the canonical description of what a verified
 * package contains. The manifest content block is hashed; provenance
 * (verification time, fetch tool, archive size) is deliberately outside the
 * hash so identity does not move when only observation time changes.
 */

export type ManifestFileEntry = {
  path: string;
  type: "file";
  mode: ModeClass;
  size: number;
  innerDigest: string;
  objectId: string;
};

export type ManifestDirEntry = {
  path: string;
  type: "dir";
};

export type ManifestSymlinkEntry = {
  path: string;
  type: "symlink";
  target: string;
};

export type ManifestEntry =
  ManifestFileEntry | ManifestDirEntry | ManifestSymlinkEntry;

export type SourceManifestContent = {
  schemaVersion: number;
  sourceId: string;
  sourceType: "registry";
  name: string;
  version: string;
  /** Credential-free registry URL. */
  origin: string;
  /** SRI of the archive the source was extracted from. */
  integrity: string;
  extractionPolicyVersion: number;
  /** Canonically ordered by `path` (code-unit order). */
  entries: ManifestEntry[];
  totals: {
    files: number;
    dirs: number;
    symlinks: number;
    logicalBytes: number;
  };
  security: {
    /** Deterministic outcome codes, sorted. */
    outcomes: string[];
  };
};

export type SourceManifestProvenance = {
  verifiedAt: string;
  tool: { name: string; version: string };
  archiveBytes: number;
};

export type SourceManifestDoc = {
  manifest: SourceManifestContent;
  manifestHash: string;
  provenance: SourceManifestProvenance;
};

export function sourceManifestPath(store: Store, sourceId: string): string {
  return path.join(store.paths.sourcesDir, sourceId, "manifest.json");
}

export function buildManifestDoc(
  manifest: SourceManifestContent,
  provenance: SourceManifestProvenance,
): SourceManifestDoc {
  return { manifest, manifestHash: manifestHashOf(manifest), provenance };
}

/**
 * Persist a source manifest. An existing manifest with the same hash is
 * reused; an existing manifest with a different hash for the same source
 * identity is corruption and fails loudly (the same digest must never
 * describe different committed bytes, I-001).
 */
export async function writeSourceManifest(
  store: Store,
  doc: SourceManifestDoc,
  options: { verifiedAt: string } = { verifiedAt: new Date().toISOString() },
): Promise<{ created: boolean }> {
  void options;
  const target = sourceManifestPath(store, doc.manifest.sourceId);
  if (await pathExists(target)) {
    const existing = await readSourceManifest(store, doc.manifest.sourceId);
    if (existing.manifestHash !== doc.manifestHash) {
      throw new ZyrkError(
        "ZYRK_STORE_CORRUPT",
        `source ${doc.manifest.sourceId} already committed with different content`,
        {
          detail: { sourceId: doc.manifest.sourceId, path: target },
          remedy:
            "run `zyrk store verify --full`; if the manifest is damaged, remove the source and re-fetch it",
        },
      );
    }
    return { created: false };
  }
  await writeFileAtomic(target, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: 0o444,
  });
  return { created: true };
}

export async function readSourceManifest(
  store: Store,
  sourceId: string,
): Promise<SourceManifestDoc> {
  const target = sourceManifestPath(store, sourceId);
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      `source manifest is unreadable: ${sourceId}`,
      {
        detail: { sourceId, path: target },
        remedy:
          "re-fetch the source; if it recurs, run `zyrk store verify --full`",
        cause: error,
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      `source manifest is not valid JSON: ${sourceId}`,
      {
        detail: { sourceId, path: target },
        remedy: "remove the damaged source directory and re-fetch it",
        cause: error,
      },
    );
  }

  const doc = validateManifestDoc(parsed, sourceId, target);
  const recomputed = manifestHashOf(doc.manifest);
  if (recomputed !== doc.manifestHash) {
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      `source manifest hash mismatch: ${sourceId}`,
      {
        detail: {
          sourceId,
          path: target,
          expected: doc.manifestHash,
          recomputed,
        },
        remedy:
          "quarantine and re-fetch this source; the stored manifest does not match its recorded digest",
      },
    );
  }
  return doc;
}

function validateManifestDoc(
  value: unknown,
  sourceId: string,
  target: string,
): SourceManifestDoc {
  function bad(why: string): never {
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      `source manifest is invalid (${why}): ${sourceId}`,
      {
        detail: { sourceId, path: target, reason: why },
        remedy: "remove the damaged source directory and re-fetch it",
      },
    );
  }

  if (typeof value !== "object" || value === null) bad("not an object");
  const doc = value as Record<string, unknown>;
  const manifest = doc["manifest"];
  if (typeof manifest !== "object" || manifest === null)
    bad("missing manifest block");
  const m = manifest as Record<string, unknown>;

  if (m["schemaVersion"] !== SOURCE_MANIFEST_SCHEMA_VERSION)
    bad("unsupported schema version");
  if (m["sourceId"] !== sourceId) bad("source id does not match its directory");
  if (m["sourceType"] !== "registry") bad("unsupported source type");
  if (typeof m["name"] !== "string" || m["name"] === "") bad("missing name");
  if (typeof m["version"] !== "string" || m["version"] === "")
    bad("missing version");
  if (typeof m["origin"] !== "string") bad("missing origin");
  if (typeof m["integrity"] !== "string") bad("missing integrity");
  if (typeof m["extractionPolicyVersion"] !== "number")
    bad("missing extraction policy version");

  const entries = m["entries"];
  if (!Array.isArray(entries)) bad("entries is not an array");
  let previousPath: string | null = null;
  let files = 0;
  let dirs = 0;
  let symlinks = 0;
  let logicalBytes = 0;
  for (const rawEntry of entries as unknown[]) {
    if (typeof rawEntry !== "object" || rawEntry === null)
      bad("entry is not an object");
    const entry = rawEntry as Record<string, unknown>;
    const entryPath = entry["path"];
    if (typeof entryPath !== "string" || entryPath === "")
      bad("entry path missing");
    validateManifestPath(entryPath, bad);
    if (previousPath !== null && !(previousPath < entryPath))
      bad("entries are not canonically ordered");
    previousPath = entryPath;

    switch (entry["type"]) {
      case "file": {
        files += 1;
        if (
          typeof entry["innerDigest"] !== "string" ||
          !/^[0-9a-f]{128}$/.test(entry["innerDigest"])
        ) {
          bad(`file entry has invalid digest: ${entryPath}`);
        }
        if (
          typeof entry["objectId"] !== "string" ||
          !/^[0-9a-f]{128}$/.test(entry["objectId"])
        ) {
          bad(`file entry has invalid object id: ${entryPath}`);
        }
        if (
          typeof entry["size"] !== "number" ||
          !Number.isInteger(entry["size"]) ||
          entry["size"] < 0
        ) {
          bad(`file entry has invalid size: ${entryPath}`);
        }
        const mode = entry["mode"];
        if (mode !== "plain" && mode !== "exec")
          bad(`file entry has invalid mode: ${entryPath}`);
        logicalBytes += entry["size"] as number;
        break;
      }
      case "dir":
        dirs += 1;
        break;
      case "symlink":
        symlinks += 1;
        if (typeof entry["target"] !== "string" || entry["target"] === "") {
          bad(`symlink entry has invalid target: ${entryPath}`);
        }
        validateSymlinkTarget(entry["target"] as string, entryPath, bad);
        break;
      default:
        bad(`entry has unknown type at ${entryPath}`);
    }
  }

  const totals = m["totals"];
  if (typeof totals !== "object" || totals === null) bad("missing totals");
  const t = totals as Record<string, unknown>;
  if (
    t["files"] !== files ||
    t["dirs"] !== dirs ||
    t["symlinks"] !== symlinks ||
    t["logicalBytes"] !== logicalBytes
  ) {
    bad("totals do not match entries");
  }

  const security = m["security"];
  if (typeof security !== "object" || security === null)
    bad("missing security block");
  const outcomes = (security as Record<string, unknown>)["outcomes"];
  if (!Array.isArray(outcomes) || outcomes.some((o) => typeof o !== "string"))
    bad("security outcomes malformed");

  const manifestHash = doc["manifestHash"];
  if (typeof manifestHash !== "string" || !/^[0-9a-f]{128}$/.test(manifestHash))
    bad("missing manifest hash");

  const provenance = doc["provenance"];
  if (typeof provenance !== "object" || provenance === null)
    bad("missing provenance");

  return doc as unknown as SourceManifestDoc;
}

/** Lexical re-validation of stored paths; never trust a stored manifest blindly. */
function validateManifestPath(
  entryPath: string,
  bad: (why: string) => never,
): void {
  if (entryPath.includes("\0")) bad("path contains NUL");
  if (entryPath.includes("\\")) bad("path contains backslash");
  if (entryPath.startsWith("/")) bad("path is absolute");
  if (/^[A-Za-z]:/.test(entryPath)) bad("path has a drive letter");
  const segments = entryPath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    bad(`path has unsafe segments: ${entryPath}`);
  }
}

function validateSymlinkTarget(
  target: string,
  entryPath: string,
  bad: (why: string) => never,
): void {
  if (target.includes("\0")) bad(`symlink target contains NUL: ${entryPath}`);
  if (target.startsWith("/")) bad(`symlink target is absolute: ${entryPath}`);
  if (/^[A-Za-z]:/.test(target) || target.startsWith("\\")) {
    bad(`symlink target escapes: ${entryPath}`);
  }
  // Walk the target relative to the link's containing directory; the level
  // must never drop below the package root.
  let level = entryPath.split("/").length - 1;
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      level -= 1;
      if (level < 0)
        bad(`symlink target escapes the package root: ${entryPath}`);
      continue;
    }
    level += 1;
  }
}
