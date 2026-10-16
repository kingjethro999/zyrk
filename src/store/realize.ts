import {
  chmod,
  link as fsLink,
  lstat,
  readdir,
  rename,
  symlink as fsSymlink,
} from "node:fs/promises";
import * as path from "node:path";
import { NexuError } from "../errors.ts";
import type { Logger } from "../log.ts";
import {
  fsyncDir,
  isErrno,
  mkdirp,
  pathExists,
  rmrfNoFollow,
} from "../util/fsx.ts";
import { contextIdFor, type GraphDoc, type GraphNode } from "./graph.ts";
import { Store } from "./layout.ts";
import { readSourceManifest } from "./manifests.ts";
import { objectPathFor, verifyObjectPayload } from "./objects.ts";
import { Transaction } from "./txn.ts";
import { verifyRealization } from "./verify.ts";

/**
 * Shared realizations (SPEC 10.1-10.2, 11.4).
 *
 * For context `ctx-a` the real package directory lives at
 * `<store>/realizations/ctx-a/node_modules/<name>/`; each dependency edge
 * appears as a sibling link at `<store>/realizations/ctx-a/node_modules/<edge>`
 * pointing at the dependency's own package directory in its realization, so
 * Node's realpath lookup finds the recorded context (I-008). Self-named
 * dependency collisions use a nested slot instead (SPEC 10.1.1). Files are
 * hard links to immutable objects; directories are read-only; a committed
 * realization is never edited in place (I-002).
 */

export type RealizeResult = {
  /** node key → the `<contextId>` directory holding its node_modules */
  realizationDirByKey: Map<string, string>;
  /** node key → the real package directory inside its realization */
  packageDirByKey: Map<string, string>;
  created: string[];
  reused: string[];
};

export function realizationDirFor(store: Store, contextId: string): string {
  return path.join(store.paths.realizationsDir, contextId);
}

/** Package directory for `name`, scoped names included (SPEC 10.2). */
export function packageDirIn(contextDir: string, name: string): string {
  return path.join(contextDir, "node_modules", ...name.split("/"));
}

export async function realizeGraph(options: {
  store: Store;
  graph: GraphDoc;
  logger?: Logger;
  /**
   * Full payload verification before publishing content that is reused
   * (SPEC 11.7). Defaults to on; tests may disable it to measure cost, which
   * must be reported separately from correctness.
   */
  verifyPayloads?: boolean;
}): Promise<RealizeResult> {
  const { store, graph } = options;
  const verify = options.verifyPayloads !== false;
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const contextByKey = new Map<string, string>();
  for (const node of graph.nodes)
    contextByKey.set(node.key, contextIdFor(graph, node.key));

  const result: RealizeResult = {
    realizationDirByKey: new Map(),
    packageDirByKey: new Map(),
    created: [],
    reused: [],
  };

  const txn = await Transaction.begin(store, "realize");
  let committed = false;
  try {
    for (const node of graph.nodes) {
      const contextId = contextByKey.get(node.key);
      if (contextId === undefined)
        throw internal(`missing context id for ${node.key}`);
      const contextDir = realizationDirFor(store, contextId);
      const packageDir = packageDirIn(contextDir, node.name);
      result.realizationDirByKey.set(node.key, contextDir);
      result.packageDirByKey.set(node.key, packageDir);

      if (await pathExists(packageDir)) {
        // S01: existence alone never authorizes reuse. The exact tree is
        // verified before it backs anything.
        if (verify) {
          await verifyRealization({
            store,
            graph,
            rootKey: node.key,
            contextId,
          });
        }
        result.reused.push(contextId);
        continue;
      }

      const stagingContext = path.join(txn.dir, "realizations", contextId);
      await buildRealization({
        store,
        node,
        byKey,
        contextByKey,
        stagingContext,
        verify,
      });
      const published = await publishRealization(contextDir, stagingContext);
      if (!published) {
        // A concurrent publisher won the race; their tree is verified
        // before it is trusted, exactly like any other reuse.
        if (verify) {
          await verifyRealization({
            store,
            graph,
            rootKey: node.key,
            contextId,
          });
        }
        result.reused.push(contextId);
        continue;
      }
      result.created.push(contextId);
    }

    await txn.setState("realizations-ready");
    committed = true;
    return result;
  } finally {
    // Staging is discardable in both paths: on success every needed tree was
    // renamed out; on failure the transaction root owns the leftovers.
    await txn.finish().catch(() => {});
    if (!committed) {
      options.logger?.debug(
        "realization transaction did not complete; staging discarded",
        {
          transactionId: txn.id,
        },
      );
    }
  }
}

async function buildRealization(options: {
  store: Store;
  node: GraphNode;
  byKey: Map<string, GraphNode>;
  contextByKey: Map<string, string>;
  stagingContext: string;
  verify: boolean;
}): Promise<void> {
  const { store, node, byKey, contextByKey, stagingContext, verify } = options;

  const manifestDoc = await readSourceManifest(store, node.sourceId);
  const manifest = manifestDoc.manifest;
  if (manifest.name !== node.name || manifest.version !== node.version) {
    throw new NexuError(
      "NEXU_STORE_CORRUPT",
      `source ${node.sourceId} contains ${manifest.name}@${manifest.version}, not ${node.name}@${node.version}`,
      {
        detail: {
          sourceId: node.sourceId,
          expected: node.key,
          found: `${manifest.name}@${manifest.version}`,
        },
        remedy:
          "run `nexu store verify --full`; the stored source no longer matches its recorded identity",
      },
    );
  }

  const packageDir = packageDirIn(stagingContext, node.name);
  await mkdirp(packageDir);

  for (const entry of manifest.entries) {
    const target = path.join(packageDir, ...entry.path.split("/"));
    switch (entry.type) {
      case "dir":
        await mkdirp(target);
        break;
      case "file": {
        await mkdirp(path.dirname(target));
        if (verify) {
          const check = await verifyObjectPayload(store, {
            objectId: entry.objectId,
            innerDigestHex: entry.innerDigest,
            modeClass: entry.mode,
            bytes: entry.size,
          });
          if (!check.ok) {
            throw new NexuError(
              "NEXU_STORE_CORRUPT",
              `object ${entry.objectId} failed verification before reuse (${check.reason})`,
              {
                detail: {
                  objectId: entry.objectId,
                  reason: check.reason,
                  sourceId: node.sourceId,
                  entryPath: entry.path,
                },
                remedy:
                  "run `nexu store verify --full` to inspect and repair the store; this realization was not published",
              },
            );
          }
        }
        await fsLink(objectPathFor(store, entry.objectId), target);
        break;
      }
      case "symlink": {
        await mkdirp(path.dirname(target));
        await fsSymlink(entry.target, target);
        break;
      }
    }
  }

  // Dependency links. The sibling slot at the context's node_modules is the
  // normal case; a name that collides with the package itself (or with an
  // already-planned edge) moves into the package's own nested node_modules.
  const siblingNames = new Set<string>([node.name]);
  for (const edge of node.edges) {
    const dependency = byKey.get(edge.target);
    const dependencyContext = contextByKey.get(edge.target);
    if (dependency === undefined || dependencyContext === undefined) {
      throw internal(`edge ${edge.name} of ${node.key} has no resolved node`);
    }
    const dependencyPackageDir = packageDirIn(
      realizationDirFor(store, dependencyContext),
      dependency.name,
    );
    const linkPath = siblingNames.has(edge.name)
      ? path.join(packageDir, "node_modules", ...edge.name.split("/"))
      : path.join(stagingContext, "node_modules", ...edge.name.split("/"));

    if (await pathExists(linkPath)) {
      // Bundled content at that slot would be silently shadowed otherwise
      // (SPEC 10.1.1); reconciliation with a selected edge is not attempted.
      throw new NexuError(
        "NEXU_RESOLUTION_FAILED",
        `cannot link dependency ${edge.name} for ${node.name}: the slot is already provided by bundled content`,
        {
          detail: { node: node.key, dependency: edge.name, slot: linkPath },
          remedy:
            "remove the bundled dependency from the package, or select a version whose bundled tree matches the resolved graph",
        },
      );
    }
    await mkdirp(path.dirname(linkPath));
    await fsSymlink(dependencyPackageDir, linkPath);
    siblingNames.add(edge.name);
  }

  await makeTreeReadOnly(stagingContext);
}

/**
 * Normalize every real directory under the staging context to read-only,
 * deepest first, without following links. Files stay at their committed
 * object mode (0444/0555); only directories change. The context root itself
 * stays writable until it is published: renaming a directory rewrites its
 * `..` entry, which requires write permission on the directory being moved.
 */
async function makeTreeReadOnly(root: string): Promise<void> {
  const dirs: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const entry = path.join(dir, name);
      const entryStat = await lstat(entry);
      if (entryStat.isDirectory()) {
        dirs.push(entry);
        await walk(entry);
      }
    }
  };
  await walk(root);
  for (const dir of dirs.reverse()) {
    await chmod(dir, 0o555);
  }
}

async function publishRealization(
  contextDir: string,
  stagingContext: string,
): Promise<boolean> {
  await mkdirp(path.dirname(contextDir));
  try {
    await rename(stagingContext, contextDir);
  } catch (error) {
    if (
      (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST")) &&
      (await pathExists(contextDir))
    ) {
      // Another process published the same context first. Identical inputs
      // produce identical content, so reuse theirs and discard ours. The
      // caller verifies the winner before trusting it (S01).
      await rmrfNoFollow(stagingContext);
      await fsyncDir(path.dirname(contextDir));
      return false;
    }
    throw error;
  }
  // The rename needed the context root writable; a committed realization
  // does not (SPEC 11.4).
  await chmod(contextDir, 0o555);
  await fsyncDir(path.dirname(contextDir));
  return true;
}

function internal(message: string): NexuError {
  return new NexuError("NEXU_INTERNAL", message);
}
