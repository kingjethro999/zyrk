/** Durable project roots and exact physical instances (SPEC 14.4, 18, 30). */
import { stat } from "node:fs/promises";
import * as path from "node:path";
import {
  openStoreDb,
  recordSource,
  recordObject,
  withTransaction,
} from "../store/db.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { contextIdFor, graphHash, type GraphDoc } from "../store/graph.ts";
import type { RealizeResult } from "../store/realize.ts";
import { sha512Hex } from "../util/hash.ts";
import { STORE_FORMAT_VERSION } from "../version.ts";

export async function registerGeneration(options: {
  store: Store;
  project: string;
  projectId: string;
  generationId: string;
  graph: GraphDoc;
  realized: RealizeResult;
  roots: readonly string[];
  readiness: "ready" | "intentionally-unbuilt";
}): Promise<{
  instances: string[];
  contexts: string[];
  activate(): void;
  close(): void;
}> {
  const { store, project, projectId, generationId, graph, realized } = options;
  const db = openStoreDb(store.paths.dbFile);
  try {
    for (const node of graph.nodes) {
      const doc = await readSourceManifest(store, node.sourceId);
      const m = doc.manifest;
      recordSource(db, {
        sourceId: m.sourceId,
        sourceType: "registry",
        name: m.name,
        version: m.version,
        origin: m.origin,
        integrity: m.integrity,
        manifestHash: doc.manifestHash,
        extractionPolicyVersion: m.extractionPolicyVersion,
        logicalBytes: m.totals.logicalBytes,
        fileCount: m.totals.files,
        entryCount: m.entries.length,
        verifiedAt: doc.provenance.verifiedAt,
      });
      for (const entry of m.entries)
        if (entry.type === "file")
          recordObject(db, {
            objectId: entry.objectId,
            innerDigest: entry.innerDigest,
            modeClass: entry.mode,
            bytes: entry.size,
            committedAt: doc.provenance.verifiedAt,
          });
    }
    const now = new Date().toISOString();
    const fs = await stat(project);
    const contexts: string[] = [];
    const instances: string[] = [];
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO projects(project_id,canonical_path,fs_dev,fs_ino,created_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET last_seen_at=excluded.last_seen_at",
      ).run(projectId, project, String(fs.dev), String(fs.ino), now, now);
      db.prepare(
        "INSERT INTO generations(generation_id,project_id,graph_digest,readiness,state,created_at) VALUES(?,?,?,?,'pending',?)",
      ).run(generationId, projectId, graphHash(graph), options.readiness, now);
      for (const node of graph.nodes) {
        const context = contextIdFor(graph, node.key);
        const directory = realized.realizationDirByKey.get(node.key)!;
        const instance = `inst1_${sha512Hex(directory).slice(0, 32)}`;
        contexts.push(context);
        instances.push(instance);
        db.prepare(
          "INSERT INTO realizations(context_id,descriptor_hash,source_id,readiness,store_format,created_at) VALUES(?,?,?,'ready',?,?) ON CONFLICT(context_id) DO NOTHING",
        ).run(context, context, node.sourceId, STORE_FORMAT_VERSION, now);
        db.prepare(
          "INSERT INTO realization_instances(instance_id,context_id,path,verification_state,created_at) VALUES(?,?,?,'verified',?) ON CONFLICT(instance_id) DO NOTHING",
        ).run(instance, context, directory, now);
        db.prepare(
          "INSERT INTO generation_instances(generation_id,context_id,instance_id,direct_link) VALUES(?,?,?,?) ON CONFLICT(generation_id,context_id) DO NOTHING",
        ).run(
          generationId,
          context,
          instance,
          options.roots.includes(node.key) ? 1 : 0,
        );
      }
      db.prepare(
        "INSERT INTO roots(root_id,project_id,generation_id,kind,state,created_at) VALUES(?,?,?,'pending','active',?)",
      ).run(`root1_${generationId}`, projectId, generationId, now);
    });
    return {
      contexts,
      instances,
      activate() {
        withTransaction(db, () => {
          db.prepare(
            "UPDATE generations SET state='rollback' WHERE project_id=? AND state='active' AND generation_id<>?",
          ).run(projectId, generationId);
          db.prepare(
            "UPDATE generations SET state='active',activated_at=? WHERE generation_id=?",
          ).run(new Date().toISOString(), generationId);
          db.prepare(
            "UPDATE roots SET kind='generation' WHERE generation_id=?",
          ).run(generationId);
        });
      },
      close() {
        db.close();
      },
    };
  } catch (cause) {
    db.close();
    throw cause;
  }
}
