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
import { SnpmError } from "../errors.ts";
import { extractTarball, type ExtractionLimits } from "../extract/tarball.ts";
import type { Logger } from "../log.ts";
import { ensureDirWithMode } from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { recordTransactionStart, type StoreDb } from "../store/db.ts";
import { Store } from "../store/layout.ts";
import { commitExtractedSource, type CommittedSource } from "../store/source.ts";
import { Transaction } from "../store/txn.ts";
import { RegistryClient, expectedIntegrityFromDist } from "./registry.ts";

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
export async function fetchAndCommitSource(options: FetchSourceOptions): Promise<FetchedSource> {
  const { store, registry, txn, name, version } = options;
  const label = `${name}@${version}`;

  // ---- 1. Metadata: exact version entry for the resolved identity ----
  const packument = await registry.packument(name);
  const entry = packument.versions[version];
  if (entry === undefined) {
    const tags = Object.entries(packument.distTags)
      .map(([tag, target]) => `${tag}=${target}`)
      .join(", ");
    throw new SnpmError("SNPM_RESOLUTION_FAILED", `registry has no version ${version} of ${name}`, {
      detail: {
        name,
        version,
        ...(tags === "" ? {} : { distTags: tags }),
      },
      remedy: "check the requested version or refresh the lockfile intentionally",
    });
  }
  if (entry.deprecated !== undefined && entry.deprecated !== "") {
    options.logger?.warn(`${label} is deprecated: ${entry.deprecated}`);
  }

  const expectedIntegrity = expectedIntegrityFromDist(entry.dist);
  if (expectedIntegrity === undefined && options.allowWeakIntegrity !== true) {
    throw new SnpmError("SNPM_INTEGRITY_FAILED", `registry metadata for ${label} carries no integrity digest`, {
      detail: { name, version },
      remedy: "strict policy rejects unpinned archives; configure the origin-verification policy explicitly to accept and pin one",
    });
  }

  // ---- 2. Download to transaction staging with bounded size ----
  const tarballDir = path.join(txn.dir, "tarballs");
  await ensureDirWithMode(tarballDir, 0o700);
  const tarballPath = path.join(tarballDir, `${sanitizeLabel(label)}.tgz`);

  const download = await registry.downloadTarball({
    url: entry.dist.tarball,
    expectedIntegrity,
    destPath: tarballPath,
    label,
    ...(options.allowWeakIntegrity === undefined ? {} : { allowWeakIntegrity: options.allowWeakIntegrity }),
  });

  if (options.db !== undefined) {
    recordTransactionStart(options.db, { txnId: txn.id, kind: "fetch" });
  }

  // ---- 3. Safe extraction into transaction-owned staging ----
  const extractDir = path.join(txn.dir, "extract", randomId("x1_", 8));
  await ensureDirWithMode(extractDir, 0o700);

  let extraction;
  try {
    extraction = await extractTarball({
      tarballPath,
      destDir: extractDir,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  } catch (error) {
    if (error instanceof SnpmError && error.code === "SNPM_EXTRACTION_UNSAFE") {
      throw error;
    }
    throw error;
  }

  for (const observation of extraction.observations) {
    options.logger?.warn(`${label}: ${observation}`);
  }

  // ---- 4. Commit objects + manifest ----
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
}

/** Filesystem-safe label for staging paths; never used as an identity. */
function sanitizeLabel(label: string): string {
  return label.replaceAll("/", "+").replaceAll("@", "at-").replaceAll(/[^A-Za-z0-9._+-]/g, "_");
}
