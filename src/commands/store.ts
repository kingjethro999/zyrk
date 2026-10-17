import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { lockedGraph } from "../install/lock.ts";
import type { NpmLockDoc } from "../lockfile/types.ts";
import { openStoreDb, type StoreDb } from "../store/db.ts";
import {
  contextIdFor,
  createGraphDoc,
  graphHash,
  validateGraph,
  type GraphDoc,
} from "../store/graph.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { objectPathFor, verifyObjectPayload } from "../store/objects.ts";
import { realizationDirFor, selectRealizationDirs } from "../store/realize.ts";
import { verifyRealization } from "../store/verify.ts";
import {
  isErrno,
  pathExists,
  rmrfNoFollow,
  writeFileAtomic,
} from "../util/fsx.ts";
import { objectIdOf } from "../util/hash.ts";
import { randomId } from "../util/ids.ts";
import { acquireLock } from "../util/locks.ts";

type Root = {
  kind: "generation" | "pin";
  projectId?: string;
  project?: string;
  graph: string;
  instances: string[];
  sources: string[];
};
type RootFile = { id: string; root: Root };
type Item = {
  relative: string;
  kind: "source" | "object" | "realization" | "graph";
  id: string;
};
const GRACE_MS = 30 * 86400_000;

function corrupt(subject: string): never {
  throw new ZyrkError(
    "ZYRK_STORE_CORRUPT",
    `Cannot inspect store ${subject}.`,
    {
      remedy:
        "Restore the damaged metadata or re-fetch the affected packages; collection stops until liveness can be established.",
    },
  );
}
function usage(): never {
  throw new ZyrkError(
    "ZYRK_USAGE",
    "Invalid store or projects command arguments.",
    {
      remedy:
        "Use store path, status, verify --full, gc [--dry-run], pin <project-or-lockfile>, unpin <pin-id>, or projects list / forget <project-id>.",
    },
  );
}
function component(value: string): string {
  if (!/^[A-Za-z0-9_-]+(?:\.json)?$/.test(value)) corrupt("identifier");
  return value;
}
async function json(file: string): Promise<unknown> {
  if (!(await fs.lstat(file)).isFile()) corrupt("metadata file type");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return corrupt("JSON metadata");
  }
}
async function names(dir: string): Promise<string[]> {
  try {
    if (!(await fs.lstat(dir)).isDirectory()) corrupt("directory type");
    return (await fs.readdir(dir)).sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
}
async function roots(store: Store): Promise<RootFile[]> {
  const result: RootFile[] = [];
  for (const id of await names(store.paths.pinsDir)) {
    component(id);
    const value = (await json(
      path.join(store.paths.pinsDir, id),
    )) as Partial<Root>;
    if (
      !value ||
      !["generation", "pin"].includes(value.kind ?? "") ||
      typeof value.graph !== "string" ||
      !Array.isArray(value.instances) ||
      !Array.isArray(value.sources)
    )
      corrupt("retention root");
    component(value.graph);
    for (const source of value.sources) {
      if (typeof source !== "string") corrupt("source root");
      component(source);
    }
    for (const instance of value.instances) {
      if (
        typeof instance !== "string" ||
        path.dirname(instance) !== store.paths.realizationsDir
      )
        corrupt("instance root");
      component(path.basename(instance));
    }
    if (
      value.kind === "generation" &&
      (typeof value.projectId !== "string" || typeof value.project !== "string")
    )
      corrupt("project root");
    result.push({ id, root: value as Root });
  }
  return result;
}
async function graphAt(store: Store, id: string): Promise<GraphDoc> {
  component(id);
  const graph = (await json(
    path.join(store.paths.graphsDir, `${id}.json`),
  )) as GraphDoc;
  try {
    validateGraph(graph);
    if (graphHash(graph) !== id) corrupt("graph digest");
  } catch {
    corrupt("graph descriptor");
  }
  for (const node of graph.nodes) component(node.sourceId);
  return graph;
}

/** All publication and root/lease mutation uses this same store barrier. */
export async function runStoreCommand(options: {
  command: "store" | "projects";
  args: readonly string[];
  store: Store;
  cwd: string;
  json?: boolean;
}): Promise<unknown> {
  const { store, args } = options;
  const [action, argument, extra] = args;
  if (options.command === "store" && action === "path" && args.length === 1)
    return { path: store.root };
  if (!store.initialized) {
    if (action === "status") return { initialized: false };
    if (options.command === "projects" && action === "list")
      return { projects: [] };
    store.requireInitialized();
  }
  const barrier = await acquireLock(
    path.join(store.paths.locksDir, "liveness.lock"),
    { name: "store liveness", timeoutMs: 30_000 },
  );
  try {
    if (options.command === "projects") {
      if (action === "list" && args.length === 1)
        return await listProjects(store);
      if (action === "forget" && argument && !extra)
        return await forgetProject(store, argument);
      usage();
    }
    if (action === "status" && args.length === 1) return await status(store);
    if (action === "verify" && argument === "--full" && !extra)
      return await verify(store);
    if (action === "gc" && (!argument || argument === "--dry-run") && !extra)
      return await collect(store, argument === "--dry-run");
    if (action === "pin" && argument && !extra)
      return await pin(store, path.resolve(options.cwd, argument));
    if (action === "unpin" && argument && !extra) {
      component(argument);
      const found = (await roots(store)).find(
        (r) => r.id === `${argument}.json` && r.root.kind === "pin",
      );
      if (!found) usage();
      await fs.unlink(path.join(store.paths.pinsDir, found.id));
      return {
        unpinned: argument,
        impact:
          "The closure can become eligible for collection after its unreferenced grace period; installed project roots remain protected.",
      };
    }
    usage();
  } finally {
    await barrier.release();
  }
}

async function listProjects(store: Store) {
  const projects = new Map<
    string,
    { projectId: string; path: string; graphs: string[]; reachability: string }
  >();
  for (const { root } of await roots(store)) {
    if (root.kind !== "generation" || !root.projectId || !root.project)
      continue;
    let project = projects.get(root.projectId);
    if (!project) {
      let reachability = "uncertain; retained";
      try {
        const state = (await json(
          path.join(root.project, ".zyrk", "install-state.json"),
        )) as { projectId?: string };
        reachability =
          state.projectId === root.projectId
            ? "present"
            : "identity mismatch; retained";
      } catch (error) {
        if (isErrno(error, "ENOENT"))
          reachability = "missing; retained until explicitly forgotten";
      }
      project = {
        projectId: root.projectId,
        path: root.project,
        graphs: [],
        reachability,
      };
      projects.set(root.projectId, project);
    }
    project.graphs.push(root.graph);
  }
  return { projects: [...projects.values()] };
}
async function forgetProject(store: Store, id: string) {
  component(id);
  const found = (await roots(store)).filter(
    ({ root }) => root.kind === "generation" && root.projectId === id,
  );
  if (!found.length) usage();
  // Root removal is explicit, never inferred from ENOENT or inaccessible media.
  for (const root of found)
    await fs.unlink(path.join(store.paths.pinsDir, root.id));
  if (await pathExists(store.paths.dbFile)) {
    const db = openStoreDb(store.paths.dbFile);
    try {
      db.prepare("UPDATE roots SET state = 'removed' WHERE project_id = ?").run(
        id,
      );
      db.prepare(
        "UPDATE generations SET state = 'abandoned' WHERE project_id = ?",
      ).run(id);
    } finally {
      db.close();
    }
  }
  return {
    forgotten: id,
    removedRoots: found.length,
    impact:
      "Surviving links in this project or moved/copied locations may break after collection. Reinstall or pin their closure before collecting.",
  };
}

async function pin(store: Store, target: string) {
  const stat = await fs.stat(target);
  const lockPath = stat.isDirectory()
    ? path.join(target, "package-lock.json")
    : target;
  const resolved = lockedGraph((await json(lockPath)) as NpmLockDoc);
  const graph = createGraphDoc(
    resolved.nodes.map((node) => ({ ...node, deps: node.edges })),
  );
  const sources = [...new Set(graph.nodes.map((node) => node.sourceId))];
  for (const id of sources) {
    component(id);
    const doc = await safeManifest(store, id);
    for (const entry of doc.manifest.entries)
      if (entry.type === "file") {
        await requireObject(store, entry);
      }
  }
  const instances: string[] = [];
  const directories = selectRealizationDirs(store, graph);
  for (const node of graph.nodes) {
    const context = contextIdFor(graph, node.key);
    if (await pathExists(directories.get(node.key)!)) {
      await verifyRealization({
        store,
        graph,
        rootKey: node.key,
        contextId: context,
        realizationDirs: directories,
      });
      instances.push(directories.get(node.key)!);
    }
  }
  const id = randomId("pin1_");
  const digest = graphHash(graph);
  await writeFileAtomic(
    path.join(store.paths.graphsDir, `${digest}.json`),
    JSON.stringify(graph),
    { mode: 0o600 },
  );
  const root: Root = { kind: "pin", graph: digest, instances, sources };
  await writeFileAtomic(
    path.join(store.paths.pinsDir, `${id}.json`),
    JSON.stringify(root),
    { mode: 0o600 },
  );
  return {
    pinId: id,
    sources: sources.length,
    scope:
      "Verified sources and existing realizations for the current platform. Native compilation still requires the project toolchain; registry metadata and tool downloads are not pinned.",
  };
}

async function safeManifest(store: Store, id: string) {
  component(id);
  const directory = path.join(store.paths.sourcesDir, id);
  await requireType(directory, "directory");
  await requireType(path.join(directory, "manifest.json"), "file");
  return await readSourceManifest(store, id);
}

async function requireType(target: string, type: "directory" | "file") {
  try {
    const stat = await fs.lstat(target);
    if (type === "directory" ? !stat.isDirectory() : !stat.isFile())
      corrupt("managed entry type");
  } catch {
    corrupt("missing or unreadable managed entry");
  }
}

async function requireObject(
  store: Store,
  entry: {
    objectId: string;
    innerDigest: string;
    mode: "plain" | "exec";
    size: number;
  },
) {
  component(entry.objectId);
  await requireType(path.join(store.paths.objectsDir, "sha512"), "directory");
  if (objectIdOf(entry.mode, entry.innerDigest) !== entry.objectId)
    corrupt("object identity");
  const target = objectPathFor(store, entry.objectId);
  await requireType(path.dirname(target), "directory");
  await requireType(target, "file");
  const result = await verifyObjectPayload(store, {
    objectId: entry.objectId,
    innerDigestHex: entry.innerDigest,
    modeClass: entry.mode,
    bytes: entry.size,
  });
  if (!result.ok) corrupt(`object payload (${result.reason})`);
}

async function inventory(store: Store): Promise<Item[]> {
  const result: Item[] = [];
  for (const [directory, kind] of [
    ["sources", "source"],
    ["realizations", "realization"],
    ["graphs", "graph"],
  ] as const) {
    for (const id of await names(path.join(store.root, directory))) {
      component(id);
      if (kind === "realization") realizationIdentity(id);
      const relative = path.join(directory, id);
      const stat = await fs.lstat(path.join(store.root, relative));
      if (kind === "graph" ? !stat.isFile() : !stat.isDirectory())
        corrupt("inventory entry type");
      result.push({
        relative,
        kind,
        id: kind === "graph" ? id.replace(/\.json$/, "") : id,
      });
    }
  }
  for (const prefix of await names(
    path.join(store.paths.objectsDir, "sha512"),
  )) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) corrupt("object prefix");
    for (const id of await names(
      path.join(store.paths.objectsDir, "sha512", prefix),
    )) {
      if (!/^[0-9a-f]{128}$/.test(id) || !id.startsWith(prefix))
        corrupt("object key");
      const relative = path.join("objects", "sha512", prefix, id);
      if (!(await fs.lstat(path.join(store.root, relative))).isFile())
        corrupt("object type");
      result.push({ relative, kind: "object", id });
    }
  }
  return result;
}

async function verify(store: Store) {
  let sources = 0,
    objects = 0,
    realizations = 0;
  const checked = new Set<string>();
  const items = await inventory(store);
  for (const { root } of await roots(store)) {
    await graphAt(store, root.graph);
    for (const source of root.sources) await safeManifest(store, source);
    for (const instance of root.instances)
      await requireType(instance, "directory");
  }
  for (const item of items.filter((item) => item.kind === "source")) {
    const doc = await safeManifest(store, item.id);
    for (const entry of doc.manifest.entries)
      if (entry.type === "file" && !checked.has(entry.objectId)) {
        await requireObject(store, entry);
        checked.add(entry.objectId);
        objects++;
      }
    sources++;
  }
  const contexts = new Set<string>();
  const instanceItems = items.filter((item) => item.kind === "realization");
  for (const item of items.filter((item) => item.kind === "graph")) {
    const graph = await graphAt(store, item.id);
    const nodesByContext = new Map(
      graph.nodes.map((node) => [contextIdFor(graph, node.key), node]),
    );
    for (const instance of instanceItems) {
      if (contexts.has(instance.id)) continue;
      const identity = realizationIdentity(instance.id);
      const node = nodesByContext.get(identity.context);
      if (!node) continue;
      const directories = new Map(
        graph.nodes.map((candidate) => [
          candidate.key,
          realizationDirFor(
            store,
            `${contextIdFor(graph, candidate.key)}${identity.suffix}`,
          ),
        ]),
      );
      await verifyRealization({
        store,
        graph,
        rootKey: node.key,
        contextId: identity.context,
        realizationDirs: directories,
      });
      contexts.add(instance.id);
      realizations++;
    }
  }
  // Unindexed payload cannot be called verified merely because it exists.
  if (items.some((item) => item.kind === "object" && !checked.has(item.id)))
    corrupt("object without a source manifest");
  if (
    items.some((item) => item.kind === "realization" && !contexts.has(item.id))
  )
    corrupt("realization without a graph descriptor");
  return { verified: true, sources, objects, realizations };
}

async function allocation(
  target: string,
  seen = new Set<string>(),
): Promise<{ logicalBytes: number; allocatedBytesEstimate: number }> {
  const stat = await fs.lstat(target);
  let logicalBytes = 0,
    allocatedBytesEstimate = 0;
  const inode = `${stat.dev}:${stat.ino}`;
  if (!seen.has(inode)) {
    seen.add(inode);
    allocatedBytesEstimate += stat.blocks * 512;
    if (stat.isFile()) logicalBytes += stat.size;
  }
  if (stat.isDirectory())
    for (const name of await fs.readdir(target)) {
      const child = await allocation(path.join(target, name), seen);
      logicalBytes += child.logicalBytes;
      allocatedBytesEstimate += child.allocatedBytesEstimate;
    }
  return { logicalBytes, allocatedBytesEstimate };
}
async function status(store: Store) {
  const categories: Record<string, unknown> = {};
  for (const name of [
    "objects",
    "sources",
    "realizations",
    "graphs",
    "staging",
    "quarantine",
    "trash",
  ] as const) {
    categories[name] = await allocation(path.join(store.root, name));
  }
  const total = await allocation(store.root);
  const retained = await roots(store);
  let logicalSourceBytesReferencedByProjects = 0;
  for (const { root } of retained.filter(
    ({ root }) => root.kind === "generation",
  )) {
    for (const id of new Set(root.sources))
      logicalSourceBytesReferencedByProjects += (await safeManifest(store, id))
        .manifest.totals.logicalBytes;
  }
  return {
    initialized: true,
    categories,
    logicalSourceBytesReferencedByProjects,
    ...total,
    allocationMethod:
      "Estimate from st_blocks deduplicated by device/inode; reflink extent sharing and exclusive reclaimability are unknown.",
    privateProjectBytes: "unavailable",
    archivesAndFetchCaches: "unavailable",
    buildOutputsAndToolCaches: "unavailable",
    retentionRoots: retained.length,
    graceDays: 30,
  };
}

async function collect(store: Store, dryRun: boolean) {
  const items = await inventory(store);
  const marked = new Set<string>();
  const reasons: string[] = [];
  const retainedRoots = await roots(store);
  const markSource = async (id: string) => {
    component(id);
    marked.add(path.join("sources", id));
    const doc = await safeManifest(store, id);
    for (const entry of doc.manifest.entries)
      if (entry.type === "file") {
        component(entry.objectId);
        marked.add(
          path.relative(store.root, objectPathFor(store, entry.objectId)),
        );
      }
  };
  for (const { root } of retainedRoots) {
    marked.add(path.join("graphs", `${root.graph}.json`));
    const graph = await graphAt(store, root.graph);
    for (const node of graph.nodes) {
      await markSource(node.sourceId);
      marked.add(
        path.relative(
          store.root,
          realizationDirFor(store, contextIdFor(graph, node.key)),
        ),
      );
    }
    for (const id of root.sources) await markSource(id);
    for (const instance of root.instances)
      marked.add(path.relative(store.root, instance));
  }
  if ((await names(store.paths.stagingDir)).length)
    reasons.push(
      "Staging work exists; retain all content until transactions are reconciled.",
    );
  if (await pathExists(store.paths.dbFile)) {
    const db = openStoreDb(store.paths.dbFile);
    try {
      if (
        db
          .prepare("SELECT lease_id FROM leases WHERE state != 'released'")
          .all().length
      )
        reasons.push("Active or uncertain process leases protect the store.");
      const activeRoots = db
        .prepare("SELECT project_id FROM roots WHERE state != 'removed'")
        .all() as { project_id: string | null }[];
      if (
        activeRoots.some(
          (root) =>
            !root.project_id ||
            !retainedRoots.some(
              ({ root: durable }) => durable.projectId === root.project_id,
            ),
        )
      )
        reasons.push(
          "Indexed roots without durable descriptors require conservative retention.",
        );
      // Any indexed generation reference is retained, including rollback/pending roots.
      const indexed = db
        .prepare(
          "SELECT DISTINCT ri.path,gi.context_id,g.generation_id,g.project_id,g.graph_digest,p.canonical_path FROM realization_instances ri JOIN generation_instances gi ON gi.instance_id=ri.instance_id JOIN generations g ON g.generation_id=gi.generation_id JOIN projects p ON p.project_id=g.project_id WHERE g.state != 'abandoned'",
        )
        .all() as {
        path: string;
        context_id: string;
        generation_id: string;
        project_id: string;
        graph_digest: string;
        canonical_path: string;
      }[];
      if (
        indexed.some((row) => {
          if (path.dirname(row.path) === store.paths.realizationsDir)
            return !marked.has(path.relative(store.root, row.path));
          // Private payloads are outside this collector's inventory. A validated
          // project/graph retention root already marks their complete CAS inputs.
          // Treat unknown external paths conservatively, never as a reason to delete.
          if (
            !/^gen1_[a-z2-7]+$/.test(row.generation_id) ||
            !/^[A-Za-z0-9_-]+$/.test(row.context_id) ||
            path.basename(row.path) !== row.context_id ||
            path.dirname(row.path) !==
              path.join(
                row.canonical_path,
                ".zyrk-local",
                "generations",
                row.generation_id,
              )
          )
            return true;
          return !retainedRoots.some(
            ({ root }) =>
              root.projectId === row.project_id &&
              root.project === row.canonical_path &&
              root.graph === row.graph_digest,
          );
        })
      )
        reasons.push(
          "Additional indexed generation instances require conservative retention.",
        );
    } finally {
      db.close();
    }
  }
  const marksFile = path.join(store.paths.metadataDir, "gc-unreferenced.json");
  const prior = (await pathExists(marksFile))
    ? ((await json(marksFile)) as Record<string, number>)
    : {};
  if (!prior || typeof prior !== "object" || Array.isArray(prior))
    corrupt("GC grace metadata");
  const next: Record<string, number> = {};
  const now = Date.now();
  let candidates: Item[] = [];
  let graceRetained = 0;
  for (const item of items) {
    if (marked.has(item.relative) || reasons.length) continue;
    const first = prior[item.relative];
    if (
      first !== undefined &&
      (!Number.isFinite(first) || first > now || first < 0)
    )
      corrupt("GC grace timestamp");
    next[item.relative] = first ?? now;
    if (first !== undefined && now - first >= GRACE_MS) candidates.push(item);
    else graceRetained++;
  }
  // Grace-retained descriptors/instances also retain their source closure.
  // A recent graph may reuse an old object whose own timer has elapsed.
  const candidatePaths = new Set(candidates.map((item) => item.relative));
  const retainedInstances = items.filter(
    (item) => item.kind === "realization" && !candidatePaths.has(item.relative),
  );
  for (const item of items.filter((item) => item.kind === "graph")) {
    const graph = await graphAt(store, item.id);
    const contexts = new Set(
      graph.nodes.map((node) => contextIdFor(graph, node.key)),
    );
    const retainedFamilies = new Set(
      retainedInstances
        .map((instance) => realizationIdentity(instance.id))
        .filter((identity) => contexts.has(identity.context))
        .map((identity) => identity.suffix),
    );
    if (!candidatePaths.has(item.relative) || retainedFamilies.size) {
      marked.add(item.relative);
      for (const node of graph.nodes) await markSource(node.sourceId);
      // A retained physical parent keeps every child in its exact incarnation,
      // including cycles; canonical paths cannot stand in for repaired paths.
      for (const suffix of retainedFamilies)
        for (const context of contexts)
          marked.add(path.join("realizations", `${context}${suffix}`));
    }
  }
  for (const item of items.filter(
    (item) =>
      item.kind === "source" &&
      (!candidatePaths.has(item.relative) || marked.has(item.relative)),
  ))
    await markSource(item.id);
  candidates = candidates.filter((item) => !marked.has(item.relative));
  const report = {
    dryRun,
    candidates: candidates.map(({ relative, kind }) => ({
      path: relative,
      kind,
      reason: "Unreferenced for at least 30 days",
    })),
    retained: items.length - candidates.length,
    graceRetained,
    retentionReasons: reasons,
    removed: 0,
    logicalBytesSelected: 0,
    physicalBytesReclaimed: "unavailable",
  };
  for (const item of candidates)
    report.logicalBytesSelected += (
      await allocation(path.join(store.root, item.relative))
    ).logicalBytes;
  if (dryRun) return report;
  await writeFileAtomic(marksFile, JSON.stringify(next), { mode: 0o600 });
  const runId = randomId("gc1_");
  const trash = path.join(store.paths.trashDir, runId);
  await fs.mkdir(trash, { mode: 0o700 });
  // The persisted plan makes interrupted detachment inspectable. Trash is never reused.
  await writeFileAtomic(path.join(trash, "plan.json"), JSON.stringify(report), {
    mode: 0o600,
  });
  for (const item of candidates) {
    const dest = path.join(trash, item.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const source = path.join(store.root, item.relative);
    const originalMode =
      item.kind === "realization"
        ? (await fs.lstat(source)).mode & 0o777
        : undefined;
    // Only an unreferenced incarnation root is made movable; package files
    // and all hard-linked payload inodes retain their original permissions.
    if (originalMode !== undefined) await fs.chmod(source, 0o700);
    try {
      await fs.rename(source, dest);
    } catch (error) {
      if (originalMode !== undefined)
        await fs.chmod(source, originalMode).catch(() => {});
      throw error;
    }
    if (await pathExists(store.paths.dbFile)) {
      const db = openStoreDb(store.paths.dbFile);
      try {
        retire(db, item, store);
      } finally {
        db.close();
      }
    }
    report.removed++;
  }
  await rmrfNoFollow(trash);
  return report;
}
function retire(db: StoreDb, item: Item, store: Store) {
  if (item.kind === "realization") {
    db.prepare(
      "UPDATE realization_instances SET verification_state = 'retired' WHERE path = ?",
    ).run(path.join(store.root, item.relative));
    db.prepare(
      "UPDATE realizations SET readiness = 'retired' WHERE context_id = ? AND NOT EXISTS (SELECT 1 FROM realization_instances WHERE realization_instances.context_id=realizations.context_id AND verification_state != 'retired')",
    ).run(realizationIdentity(item.id).context);
  }
  if (item.kind === "object")
    db.prepare("DELETE FROM objects WHERE object_id = ?").run(item.id);
  // Source index rows remain diagnostic/rebuildable while retired instances refer to them.
}

function realizationIdentity(id: string): { context: string; suffix: string } {
  const match = /^(ctx1_[0-9a-f]{128})(__repair1_[a-z2-7]{26})?$/.exec(id);
  if (!match) corrupt("physical realization identity");
  return { context: match[1]!, suffix: match[2] ?? "" };
}
