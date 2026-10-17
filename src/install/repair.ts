/** Immutable repair preparation (A-012/A-019): quarantine names, never edit inodes. */
import { lstat, rename } from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { Store } from "../store/layout.ts";
import { getSource, openStoreDb } from "../store/db.ts";
import { objectIdOf } from "../util/hash.ts";
import { readSourceManifest, sourceManifestPath } from "../store/manifests.ts";
import {
  assertObjectStorePath,
  assertRealStoreDirectory,
  newIncidentId,
  objectPathFor,
  quarantineObject,
  verifyObjectPayload,
} from "../store/objects.ts";
import { ensureDirWithMode, isErrno, writeFileAtomic } from "../util/fsx.ts";
import { randomId, ID_PREFIX } from "../util/ids.ts";

type RepairNode = {
  sourceId: string;
  name: string;
  version: string;
  origin: string;
  integrity: string;
};
export type RepairPreparation = {
  instanceSuffix: string;
  incidentId: string;
  quarantinedSources: string[];
  quarantinedObjects: string[];
};

/** Caller holds the store mutation lock and a transaction/lease protecting selected sources. */
export async function prepareRepair(options: {
  store: Store;
  graphNodes: readonly RepairNode[];
  offline?: boolean;
}): Promise<RepairPreparation> {
  const { store } = options;
  const nodes = new Map(
    options.graphNodes.map((node) => [node.sourceId, node]),
  );
  // Validate every identity before any mutation, including inputs beyond the first failure.
  for (const sourceId of nodes.keys()) sourceManifestPath(store, sourceId);
  await assertRealStoreDirectory(store.paths.sourcesDir);
  await assertRealStoreDirectory(store.paths.quarantineDir);
  const index = openStoreDb(store.paths.dbFile);
  const recordedHashes = new Map<string, string>();
  try {
    for (const node of nodes.values()) {
      const record = getSource(index, node.sourceId);
      if (record) recordedHashes.set(node.sourceId, record.manifestHash);
    }
  } finally {
    index.close();
  }
  const badSources = new Map<string, string>();
  const badObjects = new Map<string, string>();
  for (const node of nodes.values()) {
    let doc;
    try {
      doc = await readSourceManifest(store, node.sourceId);
      const m = doc.manifest;
      if (
        recordedHashes.has(node.sourceId) &&
        recordedHashes.get(node.sourceId) !== doc.manifestHash
      )
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Stored source manifest disagrees with its verified index record.",
        );
      if (
        m.entries.some(
          (entry) =>
            entry.type === "file" &&
            objectIdOf(entry.mode, entry.innerDigest) !== entry.objectId,
        )
      )
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Stored source contains inconsistent object identities.",
        );
      if (
        m.name !== node.name ||
        m.version !== node.version ||
        m.origin !== node.origin ||
        m.integrity !== node.integrity
      )
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Stored source disagrees with locked identity.",
        );
    } catch (error) {
      if (!(error instanceof ZyrkError) || error.code !== "ZYRK_STORE_CORRUPT")
        throw error;
      badSources.set(node.sourceId, "missing-or-invalid-manifest");
      continue;
    }
    for (const entry of doc.manifest.entries) {
      if (entry.type !== "file") continue;
      await assertObjectStorePath(store, entry.objectId);
      const check = await verifyObjectPayload(store, {
        objectId: entry.objectId,
        innerDigestHex: entry.innerDigest,
        modeClass: entry.mode,
      });
      if (
        check.ok &&
        (await lstat(objectPathFor(store, entry.objectId))).size !== entry.size
      )
        badSources.set(node.sourceId, "invalid-entry-size");
      if (!check.ok) {
        badObjects.set(entry.objectId, check.reason);
        badSources.set(node.sourceId, "invalid-content-object");
      }
    }
  }
  if (options.offline && badSources.size)
    throw new ZyrkError(
      "ZYRK_OFFLINE_MISSING",
      "Repair requires verified replacement source archives that are unavailable offline.",
      {
        detail: { sources: [...badSources.keys()] },
        remedy:
          "Reconnect to the configured registry and run repair again; existing project generations have been retained.",
      },
    );
  const incidentId = newIncidentId();
  const result: RepairPreparation = {
    instanceSuffix: randomId(ID_PREFIX.repair, 16),
    incidentId,
    quarantinedSources: [],
    quarantinedObjects: [],
  };
  if (!badSources.size) return result;
  for (const objectId of badObjects.keys())
    if (await quarantineObject(store, objectId, incidentId))
      result.quarantinedObjects.push(objectId);
  const quarantineSources = path.join(
    store.paths.quarantineDir,
    incidentId,
    "sources",
  );
  await ensureDirWithMode(quarantineSources, 0o700);
  for (const sourceId of badSources.keys()) {
    const sourceDir = path.dirname(sourceManifestPath(store, sourceId));
    try {
      await lstat(sourceDir);
      await rename(sourceDir, path.join(quarantineSources, sourceId));
      result.quarantinedSources.push(sourceId);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  await writeFileAtomic(
    path.join(store.paths.quarantineDir, incidentId, "incident.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "immutable-repair",
      sources: Object.fromEntries(badSources),
      objects: Object.fromEntries(badObjects),
      replacement: result.instanceSuffix,
    }),
    { mode: 0o600 },
  );
  return result;
}
