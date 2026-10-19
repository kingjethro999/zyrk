import {
  chmod,
  link as fsLink,
  lstat,
  readdir,
  rename,
  symlink as fsSymlink,
} from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { fsyncDir, mkdirp, pathExists, rmrfNoFollow } from "../util/fsx.ts";
import {
  contextIdFor,
  graphHash,
  type GraphDoc,
  type GraphNode,
} from "./graph.ts";
import { Store } from "./layout.ts";
import { openStoreDb } from "./db.ts";
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
  /** Rebuild every selected physical instance; semantic context IDs stay unchanged. */
  instanceSuffix?: string;
}): Promise<RealizeResult> {
  const { store, graph } = options;
  const verify = options.verifyPayloads !== false;
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const contextByKey = new Map<string, string>();
  for (const node of graph.nodes)
    contextByKey.set(node.key, contextIdFor(graph, node.key));

  if (
    options.instanceSuffix !== undefined &&
    !/^repair1_[a-z2-7]{26}$/.test(options.instanceSuffix)
  )
    throw internal("invalid repair instance suffix");
  const directoryByKey =
    options.instanceSuffix === undefined
      ? selectRealizationDirs(store, graph)
      : new Map(
          graph.nodes.map((node) => [
            node.key,
            realizationDirFor(
              store,
              `${contextByKey.get(node.key)!}__${options.instanceSuffix!}`,
            ),
          ]),
        );

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
      const contextDir = directoryByKey.get(node.key)!;
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
            realizationDirs: directoryByKey,
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
        directoryByKey,
        stagingContext,
        verify,
      });
      const published = await publishRealization(contextDir, stagingContext);
      if (!published) {
        // A concurrent publisher won the race; their tree is verified
        // before it is trusted, exactly like any other reuse.
        await verifyRealization({
          store,
          graph,
          rootKey: node.key,
          contextId,
          realizationDirs: directoryByKey,
        });
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
  directoryByKey: ReadonlyMap<string, string>;
  stagingContext: string;
  verify: boolean;
}): Promise<void> {
  const { store, node, byKey, contextByKey, stagingContext, verify } = options;

  const manifestDoc = await readSourceManifest(store, node.sourceId);
  const manifest = manifestDoc.manifest;
  if (manifest.name !== node.name || manifest.version !== node.version) {
    throw new ZyrkError(
      "ZYRK_STORE_CORRUPT",
      `source ${node.sourceId} contains ${manifest.name}@${manifest.version}, not ${node.name}@${node.version}`,
      {
        detail: {
          sourceId: node.sourceId,
          expected: node.key,
          found: `${manifest.name}@${manifest.version}`,
        },
        remedy:
          "run `zyrk store verify --full`; the stored source no longer matches its recorded identity",
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
            throw new ZyrkError(
              "ZYRK_STORE_CORRUPT",
              `object ${entry.objectId} failed verification before reuse (${check.reason})`,
              {
                detail: {
                  objectId: entry.objectId,
                  reason: check.reason,
                  sourceId: node.sourceId,
                  entryPath: entry.path,
                },
                remedy:
                  "run `zyrk store verify --full` to inspect and repair the store; this realization was not published",
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
      options.directoryByKey.get(dependency.key)!,
      dependency.name,
    );
    const linkPath = siblingNames.has(edge.name)
      ? path.join(packageDir, "node_modules", ...edge.name.split("/"))
      : path.join(stagingContext, "node_modules", ...edge.name.split("/"));

    if (await pathExists(linkPath)) {
      // Bundled content at that slot would be silently shadowed otherwise
      // (SPEC 10.1.1); reconciliation with a selected edge is not attempted.
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
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
    if (await pathExists(contextDir).catch(() => false)) {
      // Filesystems can report different rename errors when a concurrent
      // publisher installs a read-only destination. Existence only selects
      // the race path: the caller must fully verify this tree before reuse,
      // even when the optional payload-verification measurement is disabled.
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

function internal(message: string): ZyrkError {
  return new ZyrkError("ZYRK_INTERNAL", message);
}

/** Select one complete active generation, never an arbitrary package/version cache hit. */
export function selectRealizationDirs(
  store: Store,
  graph: GraphDoc,
): Map<string, string> {
  const contexts = new Map(
    graph.nodes.map((node) => [node.key, contextIdFor(graph, node.key)]),
  );
  const canonical = (): Map<string, string> =>
    new Map(
      [...contexts].map(([key, id]) => [key, realizationDirFor(store, id)]),
    );
  if (!contexts.size) return canonical();
  const db = openStoreDb(store.paths.dbFile);
  try {
    // A private generation records its verified shared inputs separately.
    // Families retain exact context identities and one suffix across every
    // selected parent/child, so no unrelated active canonical path can split
    // a repaired closure or override a verified replacement incarnation.
    const repairs = db
      .prepare(
        `SELECT context_id,path,created_at FROM realization_instances WHERE verification_state='verified' AND context_id IN (${[...new Set(contexts.values())].map(() => "?").join(",")}) ORDER BY created_at DESC,instance_id DESC`,
      )
      .all(...new Set(contexts.values())) as Array<{
      context_id: string;
      path: string;
      created_at: string;
    }>;
    const families = new Map<string, Map<string, string>>();
    for (const instance of repairs) {
      if (!validRealizationDirectory(store, instance.context_id, instance.path))
        continue;
      const suffix = path
        .basename(instance.path)
        .slice(instance.context_id.length);
      if (!suffix.startsWith("__repair1_")) continue;
      let family = families.get(suffix);
      if (!family) {
        family = new Map();
        families.set(suffix, family);
      }
      family.set(instance.context_id, instance.path);
    }
    for (const family of families.values())
      if ([...contexts.values()].every((id) => family.has(id)))
        return new Map(
          [...contexts].map(([key, id]) => [key, family.get(id)!]),
        );
    const generations = db
      .prepare(
        "SELECT generation_id FROM generations WHERE graph_digest=? AND state='active' ORDER BY activated_at DESC,created_at DESC,generation_id DESC",
      )
      .all(graphHash(graph)) as Array<{ generation_id: string }>;
    for (const generation of generations) {
      const records = db
        .prepare(
          "SELECT gi.context_id,ri.path FROM generation_instances gi JOIN realization_instances ri ON ri.instance_id=gi.instance_id WHERE gi.generation_id=? AND ri.verification_state='verified'",
        )
        .all(generation.generation_id) as Array<{
        context_id: string;
        path: string;
      }>;
      const byContext = new Map(
        records.map((record) => [record.context_id, record.path]),
      );
      if (
        [...contexts.values()].every((id) => {
          const dir = byContext.get(id);
          return dir !== undefined && validRealizationDirectory(store, id, dir);
        })
      )
        return new Map(
          [...contexts].map(([key, id]) => [key, byContext.get(id)!]),
        );
    }
    return canonical();
  } finally {
    db.close();
  }
}

/** Physical paths are direct managed children; a DB row never authorizes arbitrary traversal. */
export function validRealizationDirectory(
  store: Store,
  contextId: string,
  directory: string,
): boolean {
  const basename = path.basename(directory);
  return (
    path.dirname(directory) === path.resolve(store.paths.realizationsDir) &&
    (basename === contextId ||
      (basename.startsWith(`${contextId}__`) &&
        /^repair1_[a-z2-7]{26}$/.test(basename.slice(contextId.length + 2))))
  );
}
