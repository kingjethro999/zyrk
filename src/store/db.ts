import { DatabaseSync } from "node:sqlite";
import { SnpmError } from "../errors.ts";
import type { ModeClass } from "../util/hash.ts";

/**
 * The store's metadata index (SPEC 30). SQLite via the Node runtime's
 * built-in module: a version-pinned transactional database without adding a
 * native build dependency.
 *
 * The database is an index over durable filesystem facts (manifests,
 * descriptors), not the sole record of what exists; losing it must remain
 * recoverable, so nothing here may be the only copy of a decision.
 */

export const SCHEMA_VERSION = 1;

export type StoreDb = DatabaseSync;

export function openStoreDb(dbFile: string): StoreDb {
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    migrate(db);
  } catch (error) {
    // Never hand back (or leak) a connection to a schema this build cannot
    // safely interpret.
    db.close();
    throw error;
  }
  return db;
}

function userVersion(db: StoreDb): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: StoreDb): void {
  const version = userVersion(db);
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new SnpmError("SNPM_STORE_FORMAT_UNSUPPORTED", `metadata schema ${version} is newer than this snpm understands (${SCHEMA_VERSION})`, {
      detail: { schemaVersion: version, supported: SCHEMA_VERSION },
      remedy: "upgrade snpm, or point SNPM_STORE_DIR at a store created by this version",
    });
  }
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  throw new SnpmError("SNPM_INTERNAL", `no migration path from metadata schema ${version}`, {
    detail: { schemaVersion: version },
    remedy: "report this as a bug; migrations are required for every schema change",
  });
}

const SCHEMA_V1 = `
CREATE TABLE objects (
  object_id TEXT PRIMARY KEY,
  inner_digest TEXT NOT NULL,
  mode_class TEXT NOT NULL CHECK (mode_class IN ('plain','exec')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  committed_at TEXT NOT NULL
) STRICT;
CREATE INDEX objects_inner_digest ON objects (inner_digest);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('registry')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  origin TEXT NOT NULL,
  integrity TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  extraction_policy_version INTEGER NOT NULL,
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  file_count INTEGER NOT NULL CHECK (file_count >= 0),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  verified_at TEXT NOT NULL
) STRICT;
CREATE INDEX sources_name_version ON sources (name, version);

CREATE TABLE realizations (
  context_id TEXT PRIMARY KEY,
  descriptor_hash TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources (source_id),
  readiness TEXT NOT NULL CHECK (readiness IN ('building','ready','corrupt','retired')),
  store_format INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE realization_instances (
  instance_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES realizations (context_id),
  path TEXT NOT NULL UNIQUE,
  verification_state TEXT NOT NULL CHECK (verification_state IN ('unverified','verified','corrupt','retired')),
  repair_of TEXT REFERENCES realization_instances (instance_id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX realization_instances_context ON realization_instances (context_id);

CREATE TABLE edges (
  context_id TEXT NOT NULL REFERENCES realizations (context_id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dependency','peer','optional-peer','dev')),
  target_context_id TEXT NOT NULL,
  alias_of TEXT,
  PRIMARY KEY (context_id, name, kind)
) STRICT;

CREATE TABLE instance_edges (
  instance_id TEXT NOT NULL REFERENCES realization_instances (instance_id),
  slot_path TEXT NOT NULL,
  target_instance_id TEXT NOT NULL,
  target_context_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dependency','peer','optional-peer','dev')),
  name TEXT NOT NULL,
  PRIMARY KEY (instance_id, slot_path)
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  fs_dev TEXT,
  fs_ino TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX projects_canonical_path ON projects (canonical_path);

CREATE TABLE generations (
  generation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  graph_digest TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('ready','intentionally-unbuilt','blocked','failed')),
  state TEXT NOT NULL CHECK (state IN ('pending','active','rollback','abandoned')),
  private_dir TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT
) STRICT;
CREATE INDEX generations_project ON generations (project_id);

CREATE TABLE generation_instances (
  generation_id TEXT NOT NULL REFERENCES generations (generation_id),
  context_id TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES realization_instances (instance_id),
  direct_link INTEGER NOT NULL DEFAULT 0 CHECK (direct_link IN (0,1)),
  PRIMARY KEY (generation_id, context_id)
) STRICT;

CREATE TABLE roots (
  root_id TEXT PRIMARY KEY,
  project_id TEXT,
  generation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('generation','pending','pin','global-tool','prefetch')),
  state TEXT NOT NULL CHECK (state IN ('active','stale','expiring','removed')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_probe_at TEXT,
  missing_since TEXT
) STRICT;
CREATE INDEX roots_project ON roots (project_id);
CREATE INDEX roots_state ON roots (state);

CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  holder_pid INTEGER NOT NULL,
  holder_start_id TEXT,
  holder_host TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','released','uncertain')),
  created_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;
CREATE INDEX leases_state ON leases (state);

CREATE TABLE transactions (
  txn_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE pins (
  pin_id TEXT PRIMARY KEY,
  lock_digest TEXT NOT NULL,
  platform_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
) STRICT;

CREATE TABLE incidents (
  incident_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE gc_runs (
  gc_run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('marking','deleting','done','aborted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  report_json TEXT
) STRICT;
`;

/** Run a function inside an IMMEDIATE transaction. */
export function withTransaction<T>(db: StoreDb, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback failure leaves the connection in an unknown state; the
      // original error is more useful.
    }
    throw error;
  }
}

export type ObjectRecord = {
  objectId: string;
  innerDigest: string;
  modeClass: ModeClass;
  bytes: number;
  committedAt: string;
};

export function recordObject(db: StoreDb, record: ObjectRecord): void {
  db.prepare(
    `INSERT INTO objects (object_id, inner_digest, mode_class, bytes, committed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (object_id) DO NOTHING`,
  ).run(record.objectId, record.innerDigest, record.modeClass, record.bytes, record.committedAt);
}

export function getObject(db: StoreDb, objectId: string): ObjectRecord | null {
  const row = db.prepare("SELECT * FROM objects WHERE object_id = ?").get(objectId) as
    | { object_id: string; inner_digest: string; mode_class: string; bytes: number; committed_at: string }
    | undefined;
  if (row === undefined) return null;
  return {
    objectId: row.object_id,
    innerDigest: row.inner_digest,
    modeClass: row.mode_class as ModeClass,
    bytes: row.bytes,
    committedAt: row.committed_at,
  };
}

export type SourceRecord = {
  sourceId: string;
  sourceType: "registry";
  name: string;
  version: string;
  origin: string;
  integrity: string;
  manifestHash: string;
  extractionPolicyVersion: number;
  logicalBytes: number;
  fileCount: number;
  entryCount: number;
  verifiedAt: string;
};

export function recordSource(db: StoreDb, record: SourceRecord): void {
  db.prepare(
    `INSERT INTO sources (source_id, source_type, name, version, origin, integrity, manifest_hash,
                          extraction_policy_version, logical_bytes, file_count, entry_count, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id) DO NOTHING`,
  ).run(
    record.sourceId,
    record.sourceType,
    record.name,
    record.version,
    record.origin,
    record.integrity,
    record.manifestHash,
    record.extractionPolicyVersion,
    record.logicalBytes,
    record.fileCount,
    record.entryCount,
    record.verifiedAt,
  );
}

export function getSource(db: StoreDb, sourceId: string): SourceRecord | null {
  const row = db.prepare("SELECT * FROM sources WHERE source_id = ?").get(sourceId) as
    | {
        source_id: string;
        source_type: string;
        name: string;
        version: string;
        origin: string;
        integrity: string;
        manifest_hash: string;
        extraction_policy_version: number;
        logical_bytes: number;
        file_count: number;
        entry_count: number;
        verified_at: string;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    sourceId: row.source_id,
    sourceType: row.source_type as "registry",
    name: row.name,
    version: row.version,
    origin: row.origin,
    integrity: row.integrity,
    manifestHash: row.manifest_hash,
    extractionPolicyVersion: row.extraction_policy_version,
    logicalBytes: row.logical_bytes,
    fileCount: row.file_count,
    entryCount: row.entry_count,
    verifiedAt: row.verified_at,
  };
}

export function recordTransactionStart(db: StoreDb, txn: { txnId: string; kind: string; projectId?: string }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO transactions (txn_id, kind, project_id, state, started_at, updated_at)
     VALUES (?, ?, ?, 'planned', ?, ?)
     ON CONFLICT (txn_id) DO NOTHING`,
  ).run(txn.txnId, txn.kind, txn.projectId ?? null, now, now);
}

export function updateTransactionState(db: StoreDb, txnId: string, state: string): void {
  db.prepare("UPDATE transactions SET state = ?, updated_at = ? WHERE txn_id = ?").run(
    state,
    new Date().toISOString(),
    txnId,
  );
}
