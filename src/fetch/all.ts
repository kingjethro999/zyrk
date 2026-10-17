/**
 * Bounded-concurrency source fetch (SPEC 17.4).
 *
 * One slow package must not serialize the whole closure, but unbounded
 * parallelism exhausts file descriptors and memory on small machines — so
 * downloads stream through a fixed-size worker pool while results stay in
 * deterministic key order. A failed source or exhausted operation budget
 * cancels active siblings and stops queued requests. Every started worker
 * settles before the failure is returned, so staging cleanup cannot race it.
 */

import { ZyrkError, toZyrkError } from "../errors.ts";
import { Store } from "../store/layout.ts";
import { Transaction } from "../store/txn.ts";
import type { StoreDb } from "../store/db.ts";
import type { Logger } from "../log.ts";
import {
  fetchAndCommitSource,
  createFetchOperation,
  type FetchOperation,
  type FetchedSource,
  type FetchSourceOptions,
} from "./package.ts";
import type { RegistryClient } from "./registry.ts";

export const DEFAULT_FETCH_CONCURRENCY = 8;

export type SourceFetchRequest = {
  /** Deterministic identity used for ordering and error selection. */
  key: string;
  name: string;
  version: string;
};

export type FetchSourcesOptions = {
  store: Store;
  registry: RegistryClient;
  txn: Transaction;
  requests: SourceFetchRequest[];
  /** Worker count; defaults to 8, always at least 1. */
  concurrency?: number;
  maxSources?: number;
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  db?: StoreDb;
  logger?: Logger;
  limits?: FetchSourceOptions["limits"];
  allowWeakIntegrity?: boolean;
  keepTarball?: boolean;
  fetchOne?: (
    request: SourceFetchRequest,
    context: {
      store: Store;
      registry: RegistryClient;
      txn: Transaction;
      db?: StoreDb;
      logger?: Logger;
      limits?: FetchSourceOptions["limits"];
      allowWeakIntegrity?: boolean;
      keepTarball?: boolean;
      operation?: FetchOperation;
    },
  ) => Promise<FetchedSource>;
};

async function defaultFetchOne(
  request: SourceFetchRequest,
  context: {
    store: Store;
    registry: RegistryClient;
    txn: Transaction;
    db?: StoreDb;
    logger?: Logger;
    limits?: FetchSourceOptions["limits"];
    allowWeakIntegrity?: boolean;
    keepTarball?: boolean;
    operation?: FetchOperation;
  },
): Promise<FetchedSource> {
  return fetchAndCommitSource({
    store: context.store,
    registry: context.registry,
    txn: context.txn,
    ...(context.operation === undefined
      ? {}
      : { operation: context.operation }),
    name: request.name,
    version: request.version,
    ...(context.db === undefined ? {} : { db: context.db }),
    ...(context.logger === undefined ? {} : { logger: context.logger }),
    ...(context.limits === undefined ? {} : { limits: context.limits }),
    ...(context.allowWeakIntegrity === undefined
      ? {}
      : { allowWeakIntegrity: context.allowWeakIntegrity }),
    ...(context.keepTarball === undefined
      ? {}
      : { keepTarball: context.keepTarball }),
  });
}

export async function fetchSources(
  options: FetchSourcesOptions,
): Promise<Map<string, FetchedSource>> {
  const sorted = [...options.requests].sort((a, b) =>
    compareStrings(a.key, b.key),
  );
  const rawConcurrency = options.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  if (!Number.isFinite(rawConcurrency) || rawConcurrency < 1) {
    throw new ZyrkError(
      "ZYRK_INTERNAL",
      `fetch concurrency must be a finite number >= 1, got ${String(options.concurrency)}`,
      {
        detail: { concurrency: options.concurrency },
      },
    );
  }
  const maxSources = options.maxSources ?? 200_000;
  if (
    !Number.isSafeInteger(maxSources) ||
    maxSources < 1 ||
    sorted.length > maxSources
  )
    throw new ZyrkError(
      "ZYRK_FETCH_REFUSED",
      "Fetch operation exceeds its source-count budget.",
      {
        remedy:
          "Review the selected dependency graph and its source-count limit.",
      },
    );
  const budget = createFetchOperation({
    ...(options.maxArchiveBytes === undefined
      ? {}
      : { maxArchiveBytes: options.maxArchiveBytes }),
    ...(options.maxExpandedBytes === undefined
      ? {}
      : { maxExpandedBytes: options.maxExpandedBytes }),
    ...(options.deadlineMs === undefined
      ? {}
      : { deadlineMs: options.deadlineMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const operation = budget.operation;
  try {
    operation.checkpoint();
    const workers = Math.max(1, Math.floor(rawConcurrency));
    // G05: requests for the same name@version through one registry client
    // address the same origin-qualified source, so they share one download
    // (peer-split occurrences collide on the staging filename otherwise).
    // Results fan out to every requesting key afterward.
    const groups = new Map<
      string,
      { representative: SourceFetchRequest; members: number[] }
    >();
    sorted.forEach((request, index) => {
      const identity = JSON.stringify([request.name, request.version]);
      const group = groups.get(identity);
      if (group === undefined) {
        groups.set(identity, { representative: request, members: [index] });
      } else {
        group.members.push(index);
      }
    });
    const unique = [...groups.values()];
    const fetchOne = options.fetchOne ?? defaultFetchOne;
    const context = {
      store: options.store,
      registry: options.registry,
      txn: options.txn,
      operation,
      ...(options.db === undefined ? {} : { db: options.db }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.allowWeakIntegrity === undefined
        ? {}
        : { allowWeakIntegrity: options.allowWeakIntegrity }),
      ...(options.keepTarball === undefined
        ? {}
        : { keepTarball: options.keepTarball }),
    };

    const results = new Array<FetchedSource | undefined>(sorted.length);
    const failures = new Array<{ key: string; error: ZyrkError } | undefined>(
      sorted.length,
    );
    let next = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (operation.signal.aborted || budget.operation.signal.aborted) return;
        const index = next;
        next += 1;
        const group = unique[index];
        if (group === undefined) return;
        try {
          operation.checkpoint();
          const fetched = await fetchOne(group.representative, context);
          for (const member of group.members) results[member] = fetched;
        } catch (error) {
          const failure = toZyrkError(
            operation.signal.aborted &&
              operation.signal.reason instanceof ZyrkError &&
              (!(error instanceof ZyrkError) ||
                error.code === "ZYRK_FETCH_REFUSED")
              ? operation.signal.reason
              : error,
            `failed to fetch ${group.representative.key}`,
          );
          budget.abort(failure);
          for (const member of group.members) {
            const request = sorted[member];
            failures[member] = {
              key:
                request === undefined ? group.representative.key : request.key,
              error: failure,
            };
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(workers, unique.length) }, () =>
        runWorker(),
      ),
    );

    let selected: { key: string; error: ZyrkError } | undefined;
    for (const failure of failures) {
      if (failure === undefined) continue;
      if (
        selected === undefined ||
        compareStrings(failure.key, selected.key) < 0
      ) {
        selected = failure;
      }
    }
    if (selected !== undefined) throw selected.error;
    operation.checkpoint();
    budget.operation.checkpoint();

    const ordered = new Map<string, FetchedSource>();
    for (const [index, request] of sorted.entries()) {
      const result = results[index];
      if (result === undefined) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          `fetch produced no result for ${request.key}`,
          {
            detail: { key: request.key },
          },
        );
      }
      ordered.set(request.key, result);
    }
    return ordered;
  } finally {
    budget.close();
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
