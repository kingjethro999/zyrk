import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZyrkError } from "../src/errors.ts";
import {
  SCHEMA_VERSION,
  getObject,
  getSource,
  migrate,
  openStoreDb,
  recordObject,
  recordSource,
  withTransaction,
  type ObjectRecord,
  type SourceRecord,
  type StoreDb,
} from "../src/store/db.ts";

let root: string;
let dbFile: string;
let db: StoreDb;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-db-"));
  dbFile = path.join(root, "metadata", "state.sqlite");
  await mkdir(path.dirname(dbFile), { recursive: true });
  db = openStoreDb(dbFile);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const DIGEST = "ab".repeat(64);

function objectRecord(overrides: Partial<ObjectRecord> = {}): ObjectRecord {
  return {
    objectId: "0".repeat(128),
    innerDigest: DIGEST,
    modeClass: "plain",
    bytes: 5,
    committedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceId: `src1_${"a".repeat(52)}`,
    sourceType: "registry",
    name: "demo-pkg",
    version: "1.0.0",
    origin: "https://registry.npmjs.org",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    manifestHash: DIGEST,
    extractionPolicyVersion: 1,
    logicalBytes: 42,
    fileCount: 2,
    entryCount: 3,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("openStoreDb", () => {
  it("initializes schema v1 with the core tables and is idempotent", () => {
    const version = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(SCHEMA_VERSION);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["objects", "sources", "transactions"]),
    );

    expect(() => migrate(db)).not.toThrow();
    const journalMode = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe("wal");
  });

  it("refuses a newer metadata schema without leaking the connection", () => {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    let caught: unknown;
    try {
      openStoreDb(dbFile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZyrkError);
    expect((caught as ZyrkError).code).toBe("ZYRK_STORE_FORMAT_UNSUPPORTED");
  });
});

describe("record/get round trips", () => {
  it("stores object records and keeps the first publication per id", () => {
    const record = objectRecord();
    recordObject(db, record);
    expect(getObject(db, record.objectId)).toEqual(record);

    recordObject(db, {
      ...record,
      bytes: 99,
      committedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(getObject(db, record.objectId)?.bytes).toBe(5);

    expect(getObject(db, "1".repeat(128))).toBeNull();
  });

  it("stores source records and keeps the first publication per id", () => {
    const record = sourceRecord();
    recordSource(db, record);
    expect(getSource(db, record.sourceId)).toEqual(record);

    recordSource(db, { ...record, manifestHash: "cd".repeat(64) });
    expect(getSource(db, record.sourceId)?.manifestHash).toBe(DIGEST);

    expect(getSource(db, "src-missing")).toBeNull();
  });

  it("persists records across a close and reopen", () => {
    const object = objectRecord({ objectId: "2".repeat(128) });
    const source = sourceRecord({ sourceId: `src1_${"b".repeat(52)}` });
    recordObject(db, object);
    recordSource(db, source);

    db.close();
    db = openStoreDb(dbFile);

    expect(getObject(db, object.objectId)).toEqual(object);
    expect(getSource(db, source.sourceId)).toEqual(source);
  });
});

describe("withTransaction", () => {
  it("rolls back every write when the body throws", () => {
    const record = objectRecord({ objectId: "3".repeat(128) });
    expect(() =>
      withTransaction(db, () => {
        recordObject(db, record);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(getObject(db, record.objectId)).toBeNull();
  });

  it("commits every write when the body succeeds", () => {
    const record = objectRecord({ objectId: "4".repeat(128) });
    const value = withTransaction(db, () => {
      recordObject(db, record);
      return "done";
    });

    expect(value).toBe("done");
    expect(getObject(db, record.objectId)).toEqual(record);
  });
});
