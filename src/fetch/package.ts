/**
 * The fetch pipeline: registry metadata -> bounded download -> safe
 * extraction -> committed source (SPEC 8.2-8.4, 13.3-13.4).
 *
 * This is the only path that turns bytes on the network into usable store
 * content. Order matters: verify integrity before extraction; extract into
 * transaction-owned staging; commit objects and the manifest only after the
 * whole archive is accepted.
 */

import { rm } from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { extractTarball, type ExtractionLimits } from "../extract/tarball.ts";
import type { Logger } from "../log.ts";
import { ensureDirWithMode, rmrfNoFollow } from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { recordTransactionStart, type StoreDb } from "../store/db.ts";
import { Store } from "../store/layout.ts";
import {
  commitExtractedSource,
  type CommittedSource,
} from "../store/source.ts";
import { Transaction } from "../store/txn.ts";
import { RegistryClient, expectedIntegrityFromDist } from "./registry.ts";

/** Shared operation budgets count compressed network bytes and expanded parser
 * bytes (both validation and extraction passes). Limits bound work as well as
 * staging growth; reaching one cancels active requests and queued work. */
export interface FetchOperation {
  signal: AbortSignal;
  checkpoint(): void;
  consumeArchiveBytes(bytes: number): void;
  consumeExpandedBytes(bytes: number): void;
}

export function createFetchOperation(
  options: {
    maxArchiveBytes?: number;
    maxExpandedBytes?: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
): { operation: FetchOperation; abort(error: Error): void; close(): void } {
  const archiveLimit = options.maxArchiveBytes ?? 8 * 1024 ** 3;
  const expandedLimit = options.maxExpandedBytes ?? 16 * 1024 ** 3;
  const deadlineMs = options.deadlineMs ?? 15 * 60_000;
  for (const value of [archiveLimit, expandedLimit, deadlineMs])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ZyrkError(
        "ZYRK_FETCH_REFUSED",
        "Fetch operation budgets must be positive safe integers.",
        { remedy: "Select finite positive byte and deadline limits." },
      );
  const controller = new AbortController();
  const abort = (error: Error): void => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const failure = (budget: string): ZyrkError =>
    new ZyrkError(
      "ZYRK_FETCH_REFUSED",
      `Fetch operation exceeded its ${budget} budget.`,
      {
        remedy:
          "Review the selected dependency graph or explicitly increase its operation budget.",
      },
    );
  const cancel = (): void => abort(failure("cancellation"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => abort(failure("deadline")), deadlineMs);
  let archive = 0,
    expanded = 0;
  const checkpoint = (): void => controller.signal.throwIfAborted();
  const consume = (kind: "archive" | "expanded", bytes: number): void => {
    checkpoint();
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw failure("byte accounting");
    if (kind === "archive") archive += bytes;
    else expanded += bytes;
    if (archive > archiveLimit || expanded > expandedLimit) {
      abort(failure(kind + " bytes"));
      checkpoint();
    }
  };
  return {
    operation: {
      signal: controller.signal,
      checkpoint,
      consumeArchiveBytes: (bytes) => consume("archive", bytes),
      consumeExpandedBytes: (bytes) => consume("expanded", bytes),
    },
    abort,
    close() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    },
  };
}

export interface FetchSourceOptions {
  store: Store;
  registry: RegistryClient;
  txn: Transaction;
  name: string;
  version: string;
  db?: StoreDb;
  logger?: Logger;
  limits?: Partial<ExtractionLimits>;
  /** Explicit weaker-integrity policy; default refuses sha1-only metadata. */
  allowWeakIntegrity?: boolean;
  /** Keep the fetched tarball in staging after commit (default false). */
  keepTarball?: boolean;
  operation?: FetchOperation;
}

export interface FetchedSource extends CommittedSource {
  name: string;
  version: string;
  origin: string;
  integrity: string;
  archiveBytes: number;
  weakIntegrity: boolean;
  deprecated: string | undefined;
}

/**
 * Fetch one exact `name@version` and commit it as a verified source.
 * Callers resolve the version first; this function never guesses.
 */
export async function fetchAndCommitSource(
  options: FetchSourceOptions,
): Promise<FetchedSource> {
  const { store, txn, name, version } = options;
  const registry = options.registry.forPackage(name);
  const label = `${name}@${version}`;

  // ---- 1. Metadata: exact version entry for the resolved identity ----
  options.operation?.checkpoint();
  const packument = await registry.packument(
    name,
    options.operation === undefined ? {} : { signal: options.operation.signal },
  );
  const entry = packument.versions[version];
  if (entry === undefined) {
    const tags = Object.entries(packument.distTags)
      .map(([tag, target]) => `${tag}=${target}`)
      .join(", ");
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `registry has no version ${version} of ${name}`,
      {
        detail: {
          name,
          version,
          ...(tags === "" ? {} : { distTags: tags }),
        },
        remedy:
          "check the requested version or refresh the lockfile intentionally",
      },
    );
  }
  if (entry.deprecated !== undefined && entry.deprecated !== "") {
    options.logger?.warn(`${label} is deprecated: ${entry.deprecated}`);
  }

  const expectedIntegrity = expectedIntegrityFromDist(entry.dist);
  if (expectedIntegrity === undefined && options.allowWeakIntegrity !== true) {
    throw new ZyrkError(
      "ZYRK_INTEGRITY_FAILED",
      `registry metadata for ${label} carries no integrity digest`,
      {
        detail: { name, version },
        remedy:
          "strict policy rejects unpinned archives; configure the origin-verification policy explicitly to accept and pin one",
      },
    );
  }

  // ---- 2. Download to transaction staging with bounded size ----
  const tarballDir = path.join(txn.dir, "tarballs");
  await ensureDirWithMode(tarballDir, 0o700);
  const tarballPath = path.join(tarballDir, `${sanitizeLabel(label)}.tgz`);

  const extractDir = path.join(txn.dir, "extract", randomId("x1_", 8));
  let completed = false;
  try {
    const download = await registry.downloadTarball({
      url: entry.dist.tarball,
      expectedIntegrity,
      destPath: tarballPath,
      label,
      ...(options.operation === undefined
        ? {}
        : {
            signal: options.operation.signal,
            onBytes: options.operation.consumeArchiveBytes,
          }),
      ...(options.allowWeakIntegrity === undefined
        ? {}
        : { allowWeakIntegrity: options.allowWeakIntegrity }),
    });

    if (options.db !== undefined) {
      recordTransactionStart(options.db, { txnId: txn.id, kind: "fetch" });
    }

    // ---- 3. Safe extraction into transaction-owned staging ----
    await ensureDirWithMode(extractDir, 0o700);

    let extraction;
    try {
      extraction = await extractTarball({
        tarballPath,
        destDir: extractDir,
        ...(options.operation === undefined
          ? {}
          : {
              signal: options.operation.signal,
              onExpandedBytes: options.operation.consumeExpandedBytes,
            }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
    } catch (error) {
      if (
        error instanceof ZyrkError &&
        error.code === "ZYRK_EXTRACTION_UNSAFE"
      ) {
        throw error;
      }
      throw error;
    }

    for (const observation of extraction.observations) {
      options.logger?.warn(`${label}: ${observation}`);
    }

    // ---- 4. Commit objects + manifest ----
    options.operation?.checkpoint();
    const committed = await commitExtractedSource({
      store,
      extraction,
      name,
      version,
      origin: registry.origin,
      integrity: download.verifiedSri,
      archiveBytes: download.bytes,
      ...(options.db === undefined ? {} : { db: options.db }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    // ---- 5. Tarball hygiene: remove after verified commit by default ----
    if (options.keepTarball !== true) {
      await rm(tarballPath, { force: true });
    }

    options.logger?.info(
      `fetched ${label}: ${committed.fileCount} files, ${committed.logicalBytes} bytes logical, ${download.bytes} bytes archive`,
    );

    completed = true;
    return {
      ...committed,
      name,
      version,
      origin: registry.origin,
      integrity: download.verifiedSri,
      archiveBytes: download.bytes,
      weakIntegrity: download.weakIntegrity,
      deprecated: entry.deprecated,
    };
  } finally {
    await rmrfNoFollow(extractDir);
    if (!completed || options.keepTarball !== true)
      await rm(tarballPath, { force: true });
  }
}

/** Filesystem-safe label for staging paths; never used as an identity. */
function sanitizeLabel(label: string): string {
  return label
    .replaceAll("/", "+")
    .replaceAll("@", "at-")
    .replaceAll(/[^A-Za-z0-9._+-]/g, "_");
}
