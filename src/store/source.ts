/**
 * Commit verified, extracted source into the store (SPEC 8.2-8.4, §13.5).
 *
 * Flow: every extracted file becomes an immutable content object; the accepted
 * content list becomes a source manifest keyed by a credential-free source
 * identity; the optional DB records make the source listable without walking
 * the filesystem. A source whose manifest already exists with the same hash is
 * reused; a same-identity source with different content is corruption.
 *
 * Nothing here resolves versions, touches projects, or runs package code.
 */

import { SnpmError } from "../errors.ts";
import type { ExtractionResult } from "../extract/tarball.ts";
import type { Logger } from "../log.ts";
import { manifestHashOf, sourceIdOf } from "../util/hash.ts";
import { CLI_VERSION, EXTRACTION_POLICY_VERSION, SOURCE_MANIFEST_SCHEMA_VERSION } from "../version.ts";
import { recordObject, recordSource, type StoreDb } from "./db.ts";
import { Store } from "./layout.ts";
import {
  buildManifestDoc,
  writeSourceManifest,
  type ManifestEntry,
  type SourceManifestContent,
} from "./manifests.ts";
import { commitObjectFromStaging } from "./objects.ts";

export interface CommitSourceInput {
  store: Store;
  /** Result of a successful extractTarball() run whose staging dir lives in this store. */
  extraction: ExtractionResult;
  name: string;
  version: string;
  /** Credential-free registry origin (scheme://host[:port][/path]). */
  origin: string;
  /** The verified archive SRI, asserted before extraction. */
  integrity: string;
  /** Raw archive size, recorded as provenance (outside the manifest hash). */
  archiveBytes: number;
  /** When present, source and object records are written inside one transaction. */
  db?: StoreDb;
  logger?: Logger;
}

export interface CommittedSource {
  sourceId: string;
  manifestHash: string;
  /** `true` when this call created the source record; `false` on reuse. */
  created: boolean;
  fileCount: number;
  entryCount: number;
  logicalBytes: number;
}

export async function commitExtractedSource(input: CommitSourceInput): Promise<CommittedSource> {
  const { store, extraction, name, version, origin, integrity } = input;

  if (extraction.entries.length === 0) {
    throw new SnpmError("SNPM_EXTRACTION_UNSAFE", `tarball for ${name}@${version} contains no entries`, {
      detail: { name, version },
      remedy: "verify the archive contents; an empty package cannot be committed",
    });
  }

  // ---- 1. Commit every file as an immutable content object ----
  const manifestEntries: ManifestEntry[] = [];
  for (const entry of extraction.entries) {
    switch (entry.type) {
      case "file": {
        const committed = await commitObjectFromStaging(store, {
          stagingPath: entry.stagingPath,
          innerDigestHex: entry.innerDigest,
          modeClass: entry.mode,
          bytes: entry.size,
        });
        manifestEntries.push({
          path: entry.path,
          type: "file",
          mode: entry.mode,
          size: entry.size,
          innerDigest: entry.innerDigest,
          objectId: committed.objectId,
        });
        break;
      }
      case "dir":
        manifestEntries.push({ path: entry.path, type: "dir" });
        break;
      case "symlink":
        manifestEntries.push({ path: entry.path, type: "symlink", target: entry.target });
        break;
    }
  }

  // Canonical order is required by the manifest contract; enforce it here
  // rather than trusting the extractor's emission order.
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < manifestEntries.length; i += 1) {
    if (manifestEntries[i - 1]?.path === manifestEntries[i]?.path) {
      throw new SnpmError(
        "SNPM_EXTRACTION_UNSAFE",
        `tarball for ${name}@${version} produced duplicate entry paths: ${manifestEntries[i]?.path}`,
        {
          detail: { name, version, path: manifestEntries[i]?.path },
          remedy: "reject the package; duplicate archive paths are ambiguous content",
        },
      );
    }
  }

  const sourceId = sourceIdOf({ sourceType: "registry", name, version, origin, integrity });

  const manifest: SourceManifestContent = {
    schemaVersion: SOURCE_MANIFEST_SCHEMA_VERSION,
    sourceId,
    sourceType: "registry",
    name,
    version,
    origin,
    integrity,
    extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    entries: manifestEntries,
    totals: {
      files: extraction.totals.files,
      dirs: extraction.totals.dirs,
      symlinks: extraction.totals.symlinks,
      logicalBytes: extraction.totals.logicalBytes,
    },
    security: { outcomes: [...extraction.outcomes].sort() },
  };

  const verifiedAt = new Date().toISOString();
  const doc = buildManifestDoc(manifest, {
    verifiedAt,
    tool: { name: "snpm", version: CLI_VERSION },
    archiveBytes: input.archiveBytes,
  });

  // Defensive: the doc hash must be derived from the content we just built.
  if (doc.manifestHash !== manifestHashOf(manifest)) {
    throw new SnpmError("SNPM_INTERNAL", "manifest hash construction is inconsistent");
  }

  const { created } = await writeSourceManifest(store, doc);

  // ---- 2. Record metadata (best-effort durable index, rebuildable) ----
  if (input.db !== undefined) {
    const db = input.db;
    const objects = new Map<string, { innerDigest: string; modeClass: "plain" | "exec"; bytes: number }>();
    for (const entry of manifestEntries) {
      if (entry.type === "file") {
        objects.set(entry.objectId, {
          innerDigest: entry.innerDigest,
          modeClass: entry.mode,
          bytes: entry.size,
        });
      }
    }
    withSyncTransaction(db, () => {
      for (const [objectId, info] of objects) {
        recordObject(db, { objectId, ...info, committedAt: verifiedAt });
      }
      recordSource(db, {
        sourceId,
        sourceType: "registry",
        name,
        version,
        origin,
        integrity,
        manifestHash: doc.manifestHash,
        extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
        logicalBytes: extraction.totals.logicalBytes,
        fileCount: extraction.totals.files,
        entryCount: manifestEntries.length,
        verifiedAt,
      });
    }, () => {
      // A metadata write failure must not present as a failed commit: the
      // manifest is durable and the index is rebuildable (SPEC 30).
      input.logger?.debug("source metadata index update failed; index is rebuildable", { sourceId });
    });
  }

  return {
    sourceId,
    manifestHash: doc.manifestHash,
    created,
    fileCount: extraction.totals.files,
    entryCount: manifestEntries.length,
    logicalBytes: extraction.totals.logicalBytes,
  };
}

/** Run `fn` in a SQLite transaction; report failures through `onError`. */
function withSyncTransaction(db: StoreDb, fn: () => void, onError: (error: unknown) => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Keep the original error.
    }
    onError(error);
  }
}
