/** Multi-importer live workspace installation with one publication journal. */
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { InstallOptions, InstallResult } from "./run.ts";
import {
  discoverWorkspaces,
  findWorkspaceRoot,
  assertNoLiveSourceBuilds,
  type WorkspaceProject,
} from "./workspaces.ts";
import {
  resolveWorkspaceGraph,
  workspaceRegistryOccurrences,
  workspaceContextId,
  assertWorkspacePlatform,
  type WorkspaceGraph,
} from "./workspace-graph.ts";
import { workspaceOverrides } from "./workspace-overrides.ts";
import { importNpmWorkspaceLock } from "./import-npm-workspace.ts";
import { readWorkspaceLock, workspaceLockDoc } from "./workspace-lock.ts";
import {
  publishWorkspaceProjection,
  recoverWorkspaceProjection,
  workspaceProjectionPaths,
} from "./workspace-transaction.ts";
import { ZyrkError } from "../errors.ts";
import { lockMismatch } from "./lock.ts";
import { createFetchOperation } from "../fetch/package.ts";
import { extractTarball } from "../extract/tarball.ts";
import { commitExtractedSource } from "../store/source.ts";
import { readSourceManifest, sourceManifestPath } from "../store/manifests.ts";
import { objectPathFor, verifyObjectPayload } from "../store/objects.ts";
import {
  realizeGraph,
  selectRealizationDirs,
  type RealizeResult,
} from "../store/realize.ts";
import { createGraphDoc, contextIdFor, graphHash } from "../store/graph.ts";
import { Transaction } from "../store/txn.ts";
import { acquireLock } from "../util/locks.ts";
import {
  isErrno,
  pathExists,
  writeFileAtomic,
  rmrfNoFollow,
} from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import {
  configFingerprint,
  scriptPolicyFingerprint,
} from "../lockfile/fingerprints.ts";
import { currentPlatform } from "../resolve/resolver.ts";
import { installProjection, installMetadata } from "../project/projection.ts";
import { prepareWorkspaceMutation } from "./workspace-mutation.ts";
import { loadProjectPatches, applyProjectPatches } from "../commands/patch.ts";
import { prepareRepair } from "./repair.ts";
import { assertSupportedSourcePayload } from "./source-policy.ts";
import { registerGeneration } from "./metadata.ts";
import {
  candidates,
  candidateDigest,
  approveCandidate,
  assertApproved,
  buildPrivate,
} from "./private.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const unsupported = (message: string): never => {
  throw new ZyrkError("ZYRK_NOT_IMPLEMENTED", message, {
    remedy: "Use the supported workspace install options before retrying.",
  });
};
async function realDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (cause) {
    if (!isErrno(cause, "EEXIST")) throw cause;
  }
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw lockMismatch("workspace control parent must be a real directory");
}
async function readNpmWorkspaceImport(
  root: string,
  project: WorkspaceProject,
  options: InstallOptions,
): Promise<WorkspaceGraph> {
  if (options.frozen || options.offline)
    throw lockMismatch(
      "npm workspace adoption needs a non-frozen online install",
    );
  if (await pathExists(path.join(root, "npm-shrinkwrap.json")))
    throw lockMismatch(
      "npm-shrinkwrap.json takes npm precedence; workspace adoption currently supports package-lock.json only",
    );
  let npmDoc;
  try {
    npmDoc = JSON.parse(
      await readFile(path.join(root, "package-lock.json"), "utf8"),
    );
  } catch {
    throw lockMismatch(
      "npm workspace adoption needs an existing readable JSON lock",
    );
  }
  const graph = importNpmWorkspaceLock(npmDoc, project, (name) =>
    options.registry.originFor(name),
  );
  // Prove the complete graph and ordinary npm projection are representable
  // before any project state is created. Actual policy fingerprints are added
  // under the install lock after policy validation.
  workspaceLockDoc(project, graph, {
    manifest: project.manifestFingerprint,
    scripts: scriptPolicyFingerprint(undefined),
    config: configFingerprint({
      registry: options.registry.origin,
      registries: options.registry.scopedRegistries,
      linker: "shared",
    }),
  });
  return graph;
}
export async function installWorkspaceProject(
  options: InstallOptions,
): Promise<InstallResult> {
  const root = await findWorkspaceRoot(options.projectDir);
  if (!root) throw lockMismatch("no authoritative workspace root");
  workspaceOverrides(await discoverWorkspaces(root));
  // Refuse untranslatable locks before creating control directories or
  // recovering a previous generation. Revalidate under the project lock below.
  if (options.importNpm)
    await readNpmWorkspaceImport(root, await discoverWorkspaces(root), options);
  await realDirectory(path.join(root, ".zyrk-local"));
  const held = await acquireLock(path.join(root, ".zyrk-local/project.lock"), {
    name: "workspace install",
  });
  const operation = createFetchOperation(options.fetchBudget);
  let barrier: Awaited<ReturnType<typeof acquireLock>> | undefined,
    txn: Transaction | undefined,
    registration: Awaited<ReturnType<typeof registerGeneration>> | undefined;
  const stagedCleanup: string[] = [];
  try {
    await recoverWorkspaceProjection(root);
    const project = await discoverWorkspaces(root),
      rootImporter = project.importers.find((i) => i.id === ".")!,
      manifest = rootImporter.manifest;
    const originals = new Map(
      await Promise.all(
        project.importers.map(
          async (i) =>
            [
              i.id,
              await readFile(path.join(i.directory, "package.json"), "utf8"),
            ] as const,
        ),
      ),
    );
    const mutation = await prepareWorkspaceMutation(project, options);
    if (
      manifest.bundledDependencies !== undefined ||
      manifest.bundleDependencies !== undefined
    )
      unsupported("Workspace bundled root dependencies are unsupported.");
    const policy = object(manifest.zyrk) ? manifest.zyrk.scripts : undefined;
    if (
      manifest.zyrk !== undefined &&
      (!object(manifest.zyrk) ||
        Object.keys(manifest.zyrk).some(
          (k) =>
            !["scripts", "audit", "patches", "mutablePackages"].includes(k),
        ))
    )
      unsupported(
        "Workspace policy contains unsupported configuration fields.",
      );
    // Validate even empty candidates against strict policy namespaces before fetch or execution.
    if (
      policy !== undefined &&
      (!object(policy) ||
        Object.keys(policy).some(
          (k) => !["default", "allow", "deny"].includes(k),
        ) ||
        (policy.default !== undefined && policy.default !== "deny") ||
        [policy.allow, policy.deny].some(
          (v) =>
            v !== undefined &&
            (!Array.isArray(v) || v.some((x) => typeof x !== "string")),
        ))
    )
      throw new ZyrkError(
        "ZYRK_POLICY_DENIED",
        "Workspace script policy is malformed.",
        { remedy: "Use documented script allow and deny rules." },
      );
    const patches = await loadProjectPatches(root),
      patchDigest = patches.length
        ? sha512Hex(
            canonicalJson(
              patches.map((p) => ({ sourceId: p.sourceId, digest: p.digest })),
            ),
          )
        : undefined;
    const mutable = object(manifest.zyrk)
      ? manifest.zyrk.mutablePackages
      : undefined;
    if (
      mutable !== undefined &&
      (!Array.isArray(mutable) || mutable.some((v) => typeof v !== "string"))
    )
      throw new ZyrkError(
        "ZYRK_POLICY_DENIED",
        "Workspace mutablePackages must be an array of package names or source identities.",
        {
          remedy:
            "Select installed registry packages using documented mutable-package rules.",
        },
      );
    const fp = {
      manifest: project.manifestFingerprint,
      scripts: scriptPolicyFingerprint(policy),
      config: configFingerprint({
        registry: options.registry.origin,
        registries: options.registry.scopedRegistries,
        linker: "shared",
        platform: currentPlatform(),
        ...(mutable !== undefined
          ? { mutablePackages: mutable as string[] }
          : {}),
        ...(patchDigest ? { patches: patchDigest } : {}),
      }),
    };
    const imported = options.importNpm
      ? await readNpmWorkspaceImport(root, project, options)
      : undefined;
    let existing = options.importNpm
        ? null
        : await readWorkspaceLock(root, project, (name) =>
            options.registry.originFor(name),
          ),
      graph: WorkspaceGraph | undefined = imported;

    if (existing) {
      const ext = existing.doc.zyrk!;
      if (
        !mutation.changed &&
        ext.manifest === fp.manifest &&
        ext.scripts === fp.scripts &&
        ext.config === fp.config
      )
        graph = existing.graph;
      else if (options.frozen || options.offline)
        throw lockMismatch("workspace manifest or policy fingerprint differs");
    }
    if (!graph) {
      if (options.frozen || options.offline)
        throw lockMismatch(
          "offline/frozen workspace install needs a compatible lock",
        );
      options.onProgress?.({ phase: "resolving" });
      graph = await resolveWorkspaceGraph(
        project,
        {
          origin: options.registry.origin,
          originFor: (name: string) => options.registry.originFor(name),
          packument: (name) =>
            options.registry.packument(name, {
              signal: operation.operation.signal,
            }),
        },
        {
          ...(existing ? { previous: existing.graph } : {}),
          fresh: mutation.fresh,
          ...options.resolveBudget,
        },
      );
    }
    assertWorkspacePlatform(graph);
    mutation.finish(graph);
    fp.manifest = project.manifestFingerprint;
    const manifestChanges = project.importers
      .filter(
        (i) =>
          JSON.stringify(i.manifest) !==
          JSON.stringify(JSON.parse(originals.get(i.id)!)),
      )
      .map((i) => ({
        id: i.id,
        before: originals.get(i.id)!,
        after: JSON.stringify(i.manifest, null, 2) + "\n",
      }));
    const doc =
        options.frozen && existing
          ? existing.doc
          : workspaceLockDoc(project, graph, fp),
      lockText = options.frozen
        ? await readFile(path.join(root, "package-lock.json"), "utf8")
        : JSON.stringify(doc, null, 2) + "\n";
    const warnings = graph.omissions.map(
      (o) => `${o.name}: omitted incompatible optional workspace dependency.`,
    );
    for (const importer of project.importers)
      for (const stage of ["preinstall", "install", "postinstall"])
        if (importer.manifest.scripts?.[stage])
          warnings.push(
            `${importer.id}: ${stage} hook was not run; invoke it explicitly after installation.`,
          );
    if (options.lockfileOnly) {
      await publishWorkspaceProjection(
        root,
        `gen1_${randomId("", 12)}`,
        project.importers.map((i) => i.id),
        lockText,
        manifestChanges,
        true,
      );
      return {
        readiness: "lockfile-only",
        packages: graph.nodes.length - project.importers.length,
        reused: 0,
        warnings,
      };
    }
    // Omission applies to importer dev roots; follow all transitive registry and live edges.
    const byKey = new Map(graph.nodes.map((n) => [n.key, n])),
      active = new Set<string>();
    const visit = (key: string): void => {
      if (active.has(key)) return;
      active.add(key);
      const node = byKey.get(key)!;
      for (const edge of node.edges)
        if (!(options.omitDev && node.kind === "local" && edge.kind === "dev"))
          visit(edge.target);
    };
    for (const key of Object.values(graph.importers)) visit(key);
    const activeGraph = {
      ...graph,
      nodes: graph.nodes
        .filter((n) => active.has(n.key))
        .map((n) => ({
          ...n,
          edges: n.edges.filter(
            (e) => !(options.omitDev && n.kind === "local" && e.kind === "dev"),
          ),
        })),
    };
    for (const rule of (mutable ?? []) as string[])
      if (
        !activeGraph.nodes.some(
          (n) =>
            n.name === rule || (n.kind === "registry" && n.sourceId === rule),
        )
      )
        throw new ZyrkError(
          "ZYRK_POLICY_DENIED",
          "A workspace mutable selector does not match the selected graph.",
          {
            remedy:
              "Choose a package name or source identity present in the workspace graph.",
          },
        );
    const nodes = workspaceRegistryOccurrences(activeGraph),
      registryKeys = new Set(nodes.map((n) => n.key));
    // A registry context is shareable exactly when its complete closure contains no live source.
    const privateKeys = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes)
        if (
          !privateKeys.has(node.key) &&
          node.edges.some(
            (e) => !registryKeys.has(e.target) || privateKeys.has(e.target),
          )
        ) {
          privateKeys.add(node.key);
          changed = true;
        }
    }
    const sourceGraph = createGraphDoc(
      nodes.map((n) => ({
        ...n,
        deps: n.edges.filter((e) => registryKeys.has(e.target)),
      })),
    );
    const pureGraph = createGraphDoc(
      nodes
        .filter((n) => !privateKeys.has(n.key))
        .map((n) => ({ ...n, deps: n.edges })),
    );
    barrier = await acquireLock(
      path.join(options.store.paths.locksDir, "liveness.lock"),
      { name: "store liveness" },
    );
    txn = await Transaction.begin(options.store, "install");
    const repairOf = options.repair
      ? selectRealizationDirs(options.store, pureGraph)
      : undefined;
    const repair = options.repair
      ? await prepareRepair({
          store: options.store,
          graphNodes: nodes,
          offline: options.offline === true,
        })
      : undefined;
    const uniqueSources = new Map(nodes.map((n) => [n.sourceId, n]));
    let completedSources = 0;
    options.onProgress?.({
      phase: "fetching",
      completed: 0,
      total: uniqueSources.size,
    });
    for (const node of uniqueSources.values()) {
      operation.operation.checkpoint();
      if (
        !(await pathExists(sourceManifestPath(options.store, node.sourceId)))
      ) {
        if (options.offline)
          throw new ZyrkError(
            "ZYRK_OFFLINE_MISSING",
            `Verified workspace dependency ${node.name}@${node.version} is missing.`,
            {
              remedy:
                "Fetch the exact locked sources online before retrying offline.",
            },
          );
        const archive = path.join(txn.dir, `${node.sourceId}.tgz`),
          download = await options.registry
            .forPackage(node.name)
            .downloadTarball({
              url: node.tarballUrl,
              expectedIntegrity: node.integrity,
              destPath: archive,
              label: `${node.name}@${node.version}`,
              signal: operation.operation.signal,
              onBytes: operation.operation.consumeArchiveBytes,
            });
        const extraction = await extractTarball({
          limits: options.extractBudget!,
          tarballPath: archive,
          destDir: path.join(txn.dir, node.sourceId),
          signal: operation.operation.signal,
          onExpandedBytes: operation.operation.consumeExpandedBytes,
        });
        const source = await commitExtractedSource({
          store: options.store,
          extraction,
          name: node.name,
          version: node.version,
          origin: node.origin,
          integrity: download.verifiedSri,
          archiveBytes: download.bytes,
        });
        if (source.sourceId !== node.sourceId)
          throw lockMismatch("workspace archive identity differs");
        await rm(archive, { force: true });
      }
      assertSupportedSourcePayload(
        node,
        await readSourceManifest(options.store, node.sourceId),
      );
      options.onProgress?.({
        phase: "fetching",
        completed: ++completedSources,
        total: uniqueSources.size,
      });
    }
    if (options.fetchOnly)
      return {
        readiness: "fetched",
        packages: nodes.length,
        reused: 0,
        warnings,
      };
    options.onProgress?.({ phase: "realizing" });
    const shared = await realizeGraph({
        store: options.store,
        graph: pureGraph,
        ...(repair ? { instanceSuffix: repair.instanceSuffix } : {}),
      }),
      realized: RealizeResult = {
        realizationDirByKey: new Map(shared.realizationDirByKey),
        packageDirByKey: new Map(shared.packageDirByKey),
        created: [...shared.created],
        reused: [...shared.reused],
      };
    for (const node of activeGraph.nodes)
      if (node.kind === "local")
        realized.packageDirByKey.set(
          node.key,
          project.importers.find((i) => i.id === node.importer)!.directory,
        );
    const generationId = `gen1_${randomId("", 12)}`,
      projectId = `project1_${sha512Hex(root).slice(0, 32)}`,
      base = path.join(root, ".zyrk-local/generations", generationId),
      contexts = new Map<string, string>();
    await realDirectory(path.dirname(base));
    await realDirectory(base);
    const allocatedContexts = new Set<string>();
    const allocatePrivate = async (keys: Set<string>) => {
      for (const node of nodes)
        if (keys.has(node.key) && !contexts.has(node.key)) {
          // Project-qualified semantic descriptor includes the full live peer graph.
          const context = privateKeys.has(node.key)
              ? workspaceContextId(activeGraph, node.key, projectId)
              : contextIdFor(sourceGraph, node.key),
            dir = path.join(base, context),
            pkg = path.join(dir, "node_modules", ...node.name.split("/"));
          contexts.set(node.key, context);
          realized.realizationDirByKey.set(node.key, dir);
          realized.packageDirByKey.set(node.key, pkg);
          if (allocatedContexts.has(context)) continue;
          allocatedContexts.add(context);
          await mkdir(pkg, { recursive: true });
          const source = (
            await readSourceManifest(options.store, node.sourceId)
          ).manifest;
          for (const entry of source.entries) {
            const file = path.join(pkg, ...entry.path.split("/"));
            if (entry.type === "dir") {
              await mkdir(file, { recursive: true });
              continue;
            }
            await mkdir(path.dirname(file), { recursive: true });
            if (entry.type === "symlink") {
              await symlink(entry.target, file);
              continue;
            }
            const checked = await verifyObjectPayload(options.store, {
              objectId: entry.objectId,
              innerDigestHex: entry.innerDigest,
              modeClass: entry.mode,
              bytes: entry.size,
            });
            if (!checked.ok)
              throw new ZyrkError(
                "ZYRK_STORE_CORRUPT",
                "Cannot initialize workspace context from corrupt source.",
                { remedy: "Repair the verified source before retrying." },
              );
            await copyFile(
              objectPathFor(options.store, entry.objectId),
              file,
              constants.COPYFILE_FICLONE,
            );
            await chmod(file, entry.mode === "exec" ? 0o755 : 0o644);
            if ((await lstat(file)).nlink !== 1)
              throw lockMismatch("workspace writable inode shares source");
          }
        }
      // All targets are allocated before wiring cycles and peer edges.
      for (const node of nodes)
        if (keys.has(node.key)) {
          const pkg = realized.packageDirByKey.get(node.key)!,
            dir = realized.realizationDirByKey.get(node.key)!;
          for (const edge of node.edges) {
            const slot = path.join(
              edge.name === node.name
                ? path.join(pkg, "node_modules")
                : path.join(dir, "node_modules"),
              ...edge.name.split("/"),
            );
            try {
              const old = await lstat(slot);
              if (!old.isSymbolicLink())
                throw lockMismatch("workspace dependency slot shadows payload");
              await rm(slot);
            } catch (cause) {
              if (!isErrno(cause, "ENOENT")) throw cause;
            }
            await mkdir(path.dirname(slot), { recursive: true });
            await symlink(realized.packageDirByKey.get(edge.target)!, slot);
          }
        }
    };
    await allocatePrivate(
      patches.length || (Array.isArray(mutable) && mutable.length)
        ? new Set(nodes.map((n) => n.key))
        : privateKeys,
    );
    if (patches.length) {
      const applied = await applyProjectPatches({
        project: root,
        store: options.store,
        packages: new Map(
          nodes.map((n) => [
            n.key,
            {
              sourceId: n.sourceId,
              directory: realized.packageDirByKey.get(n.key)!,
            },
          ]),
        ),
      });
      if (applied.digest !== patchDigest)
        throw lockMismatch(
          "workspace patch artifacts changed during installation",
        );
    }

    const builds = await candidates(nodes, realized.packageDirByKey),
      digest = candidateDigest(
        sourceGraph,
        builds,
        policy,
        sha512Hex(
          canonicalJson({ graph: activeGraph, patches: patchDigest ?? null }),
        ),
      );
    if (builds.length && !options.ignoreScripts)
      assertNoLiveSourceBuilds({
        builds,
        edges: new Map(
          activeGraph.nodes.map((n) => [n.key, n.edges.map((e) => e.target)]),
        ),
        liveSources: new Map(
          activeGraph.nodes
            .filter((n) => n.kind === "local")
            .map((n) => [n.key, n.importer]),
        ),
      });
    if (options.reviewBuilds) {
      await writeFileAtomic(
        path.join(root, ".zyrk-local/build-candidate.json"),
        JSON.stringify({ schemaVersion: 1, candidate: digest, builds }),
        { mode: 0o600 },
      );
      if (options.approveBuilds)
        await approveCandidate({
          project: root,
          digest,
          builds,
          selected: options.approveBuilds,
          env: options.env ?? process.env,
          policy,
        });
      return {
        readiness: "build-review",
        packages: nodes.length,
        reused: shared.reused.length,
        warnings,
        candidateDigest: digest,
        builds,
      };
    }
    if (builds.length && !options.ignoreScripts) {
      await assertApproved({
        project: root,
        env: options.env ?? process.env,
        digest,
        builds,
        policy,
      });
      // Approved writes need a coherent fully private registry closure.
      await allocatePrivate(new Set(nodes.map((n) => n.key)));
      options.onProgress?.({ phase: "building" });
      await buildPrivate({
        project: root,
        generationId,
        nodes,
        builds,
        realized,
        env: options.env ?? process.env,
      });
    }
    const readiness =
      builds.length && options.ignoreScripts
        ? "intentionally-unbuilt"
        : "ready";
    registration = await registerGeneration({
      store: options.store,
      project: root,
      projectId,
      generationId,
      graph: sourceGraph,
      realized,
      sharedRealized: shared,
      contextIds: contexts,
      ...(repairOf ? { repairOf } : {}),
      roots: activeGraph.nodes
        .filter((n) => n.kind === "local")
        .flatMap((n) => n.edges.map((e) => e.target))
        .filter((k) => registryKeys.has(k)),
      readiness,
    });
    for (const importer of project.importers) {
      const node = activeGraph.nodes.find(
        (n) => n.key === activeGraph.importers[importer.id],
      )!;
      const holder = path.join(
        base,
        "projections",
        sha512Hex(importer.id).slice(0, 16),
      );
      await mkdir(holder, { recursive: true });
      const bins: Record<string, string> = {};
      for (const edge of node.edges) {
        const child = byKey.get(edge.target)!,
          directory = realized.packageDirByKey.get(child.key)!;
        const bin =
          child.kind === "registry"
            ? child.bin
            : project.importers.find((i) => i.id === child.importer)!.manifest
                .bin;
        const entries =
          typeof bin === "string"
            ? { [child.name.split("/").at(-1)!]: bin }
            : object(bin)
              ? bin
              : {};
        for (const [name, target] of Object.entries(entries)) {
          if (typeof target !== "string")
            throw lockMismatch("invalid workspace executable");
          const actual = await realpath(path.resolve(directory, target));
          if (
            !actual.startsWith(directory + path.sep) ||
            !(await lstat(actual)).isFile() ||
            (bins[name] && bins[name] !== actual)
          )
            throw lockMismatch(
              "workspace executable escapes source or conflicts",
            );
          bins[name] = actual;
        }
      }
      options.onProgress?.({ phase: "linking" });
      await installProjection(
        holder,
        node.edges.map((e) => ({
          name: e.name,
          linkTarget: realized.packageDirByKey.get(e.target)!,
        })),
        {
          generationId,
          projectId,
          bins,
          readiness,
          metadata: {
            linker: contexts.size ? "private" : "shared",
            workspaceRoot: root,
            importer: importer.id,
            storeRoot: options.store.paths.root,
            instances: registration.instances,
            activeContexts: registration.contexts,
            lockDigest: sha512Hex(canonicalJson(doc)),
            registryConfig: {
              registry: options.registry.origin,
              registries: options.registry.scopedRegistries,
            },
            graphDigest: graphHash(sourceGraph),
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            privateDir: contexts.size ? base : null,
            buildProfile: contexts.size
              ? {
                  node: process.version,
                  abi: process.versions.modules,
                  platform: process.platform,
                  arch: process.arch,
                  candidate: digest,
                  patches: patchDigest ?? null,
                }
              : null,
          },
        },
      );
      stagedCleanup.push(
        workspaceProjectionPaths(root, importer.id, generationId).staged,
      );
      await rename(
        path.join(holder, "node_modules"),
        workspaceProjectionPaths(root, importer.id, generationId).staged,
      );
    }
    for (const importer of project.importers)
      if (
        (await readFile(
          path.join(importer.directory, "package.json"),
          "utf8",
        )) !== originals.get(importer.id)
      )
        throw lockMismatch("workspace manifest changed during install");
    await publishWorkspaceProjection(
      root,
      generationId,
      project.importers.map((i) => i.id),
      lockText,
      manifestChanges,
    );
    registration.activate();
    return {
      readiness,
      packages: nodes.length,
      reused: shared.reused.length,
      warnings,
      generationId,
    };
  } catch (cause) {
    await recoverWorkspaceProjection(root);
    throw cause;
  } finally {
    for (const staged of stagedCleanup) await rmrfNoFollow(staged);
    operation.close();
    registration?.close();
    try {
      await txn?.finish();
    } finally {
      await barrier?.release();
      await held.release();
    }
  }
}
