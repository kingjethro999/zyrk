import { sourceProgress, reportLinked } from "./progress.ts";
import { selectPlatformGraph } from "./platform.ts";
import type { RuntimePlatform } from "../resolve/resolver.ts";
import { findWorkspaceRoot } from "./workspaces.ts";
import { assertSupportedSourcePayload } from "./source-policy.ts";
import { prepareRepair } from "./repair.ts";
import { createFetchOperation } from "../fetch/package.ts";
import {
  candidates,
  candidateDigest,
  approveCandidate,
  assertApproved,
  materializePrivate,
  buildPrivate,
  type BuildCandidate,
} from "./private.ts";
import { loadProjectPatches, applyProjectPatches } from "../commands/patch.ts";
import { registerGeneration } from "./metadata.ts";
import { randomId } from "../util/ids.ts";
import { createRootOverrides } from "../resolve/overrides.ts";
import { importNpmLock } from "./import-npm.ts";
/** Native project install: resolve -> verify -> realize -> journaled publication. */
import { readFile, realpath, lstat, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import npa from "npm-package-arg";
import { satisfies } from "semver";
import { ZyrkError } from "../errors.ts";
import { RegistryClient } from "../fetch/registry.ts";
import { installBudgets } from "./budgets.ts";
import type { ResolverLimits } from "../resolve/resolver.ts";
import type { ExtractionLimits } from "../extract/tarball.ts";
import { extractTarball } from "../extract/tarball.ts";
import { commitExtractedSource } from "../store/source.ts";
import { Store } from "../store/layout.ts";
import { Transaction } from "../store/txn.ts";
import { readSourceManifest, sourceManifestPath } from "../store/manifests.ts";
import { realizeGraph, selectRealizationDirs } from "../store/realize.ts";
import { createGraphDoc, graphHash } from "../store/graph.ts";
import {
  resolveRequirements,
  type FinalizedGraph,
} from "../resolve/resolver.ts";
import { parseRequirement } from "../resolve/spec.ts";
import { readLockfile, assertFrozenCompatible } from "../lockfile/read.ts";
import { writeLockfile } from "../lockfile/write.ts";
import {
  configFingerprint,
  manifestFingerprint,
  scriptPolicyFingerprint,
  type ManifestDeclaration,
} from "../lockfile/fingerprints.ts";
import {
  installProjection,
  installMetadata,
  recoverProjection,
  PROJECT_STATE_DIR,
  type ProjectionEntry,
} from "../project/projection.ts";
import { acquireLock } from "../util/locks.ts";
import { isErrno, pathExists, writeFileAtomic } from "../util/fsx.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { lockedGraph, packageName, cleanUrl, lockMismatch } from "./lock.ts";

export type InstallProgress = {
  phase:
    | "planning"
    | "resolving"
    | "fetching"
    | "realizing"
    | "building"
    | "linking"
    | "complete";
  completed?: number;
  total?: number;
  reused?: number;
  downloaded?: number;
  package?: {
    name: string;
    version: string;
    status: "downloading" | "downloaded" | "reused" | "linked";
    bytes?: number;
  };
};
export type InstallOptions = {
  onProgress?: (event: InstallProgress) => void;
  projectDir: string;
  /** Target selection only; Store.open still checks the actual host. */
  platform?: RuntimePlatform;
  store: Store;
  registry: RegistryClient;
  specs?: readonly string[];
  saveDev?: boolean;
  saveOptional?: boolean;
  importNpm?: boolean;
  mutation?: {
    remove?: readonly string[];
    update?: readonly string[];
    latest?: boolean;
  };
  saveExact?: boolean;
  frozen?: boolean;
  offline?: boolean;
  ignoreScripts?: boolean;
  lockfileOnly?: boolean;
  fetchOnly?: boolean;
  omitDev?: boolean;
  env?: NodeJS.ProcessEnv;
  reviewBuilds?: boolean;
  approveBuilds?: readonly string[];
  rebuild?: boolean;
  repair?: boolean;
  resolveBudget?: Partial<ResolverLimits>;
  extractBudget?: Partial<ExtractionLimits>;
  fetchBudget?: {
    maxArchiveBytes?: number;
    maxExpandedBytes?: number;
    deadlineMs?: number;
  };
};
export type InstallResult = {
  readiness:
    | "ready"
    | "intentionally-unbuilt"
    | "lockfile-only"
    | "fetched"
    | "build-review";
  packages: number;
  reused: number;
  warnings: string[];
  generationId?: string;
  candidateDigest?: string;
  builds?: BuildCandidate[];
};
type Manifest = ManifestDeclaration & {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  zyrk?: unknown;
  [key: string]: unknown;
};
function error(
  code:
    | "ZYRK_MANIFEST_INVALID"
    | "ZYRK_NOT_IMPLEMENTED"
    | "ZYRK_POLICY_DENIED"
    | "ZYRK_USAGE"
    | "ZYRK_OFFLINE_MISSING",
  message: string,
): ZyrkError {
  return new ZyrkError(code, message, {
    remedy:
      "Review package.json and the documented zyrk install options, then retry.",
  });
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readManifest(
  project: string,
): Promise<{ doc: Manifest; text: string }> {
  let doc: unknown, text: string;
  try {
    text = await readFile(path.join(project, "package.json"), "utf8");
    doc = JSON.parse(text);
  } catch {
    throw error(
      "ZYRK_MANIFEST_INVALID",
      "Cannot read the project's package.json as JSON.",
    );
  }
  if (!object(doc))
    throw error(
      "ZYRK_MANIFEST_INVALID",
      "Project package.json must be an object.",
    );
  for (const group of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const entries = doc[group];
    if (entries === undefined) continue;
    if (
      !object(entries) ||
      Object.entries(entries).some(
        ([name, spec]) => !packageName(name) || typeof spec !== "string",
      )
    )
      throw error(
        "ZYRK_MANIFEST_INVALID",
        `Project ${group} must contain valid package names and string specifiers.`,
      );
  }
  if (
    doc.workspaces !== undefined ||
    doc.bundledDependencies !== undefined ||
    doc.bundleDependencies !== undefined
  )
    throw error(
      "ZYRK_NOT_IMPLEMENTED",
      "Project workspaces and bundled dependencies are not supported by install yet.",
    );
  if (
    doc.zyrk !== undefined &&
    (!object(doc.zyrk) ||
      Object.keys(doc.zyrk).some(
        (key) =>
          !["scripts", "audit", "patches", "mutablePackages"].includes(key),
      ) ||
      (doc.zyrk.scripts !== undefined &&
        (!object(doc.zyrk.scripts) ||
          Object.keys(doc.zyrk.scripts).some(
            (k) => !["default", "allow", "deny"].includes(k),
          ) ||
          (doc.zyrk.scripts.default !== undefined &&
            doc.zyrk.scripts.default !== "deny") ||
          [doc.zyrk.scripts.allow, doc.zyrk.scripts.deny].some(
            (v) =>
              v !== undefined &&
              (!Array.isArray(v) || v.some((x) => typeof x !== "string")),
          ))))
  )
    throw error(
      "ZYRK_POLICY_DENIED",
      "Project zyrk policy contains unsupported settings; use documented script, patch, audit, or mutable-package configuration.",
    );
  return { doc: doc as Manifest, text };
}
function requirements(manifest: Manifest): Record<string, string> {
  return {
    ...manifest.devDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
}
function scriptPolicy(manifest: Manifest): unknown {
  return object(manifest.zyrk) ? manifest.zyrk.scripts : undefined;
}

export async function installProject(
  options: InstallOptions,
): Promise<InstallResult> {
  options.onProgress?.({ phase: "planning" });
  const budgets = installBudgets(options.env ?? process.env);
  options = {
    ...options,
    resolveBudget: { ...budgets.resolveBudget, ...options.resolveBudget },
    extractBudget: { ...budgets.extractBudget, ...options.extractBudget },
  };
  if (await findWorkspaceRoot(options.projectDir)) {
    const { installWorkspaceProject } = await import("./workspace-install.ts");
    return installWorkspaceProject(options);
  }
  const project = await realpath(options.projectDir);
  const preliminaryManifest = (await readManifest(project)).doc;
  const preliminaryOverrides = createRootOverrides(preliminaryManifest);
  if (options.importNpm) {
    const preliminaryLock = (
      await readLockfile(path.join(project, "package-lock.json"))
    )?.doc;
    if (preliminaryLock && !preliminaryLock.zyrk)
      importNpmLock(
        preliminaryLock,
        requirements(preliminaryManifest),
        (name) => options.registry.originFor(name),
        preliminaryOverrides,
      );
  }
  // A local control-directory link would redirect locks and recovery writes.
  const local = path.join(project, PROJECT_STATE_DIR);
  try {
    const stat = await lstat(local);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw error(
        "ZYRK_POLICY_DENIED",
        "Project control directory must be a real directory.",
      );
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
    await mkdir(local, { mode: 0o700, recursive: true });
    const created = await lstat(local);
    if (!created.isDirectory() || created.isSymbolicLink())
      throw error(
        "ZYRK_POLICY_DENIED",
        "Project control directory must be a real directory.",
      );
  }
  const held = await acquireLock(path.join(local, "project.lock"), {
    name: "project install",
  });
  const operation = createFetchOperation(options.fetchBudget);
  let txn: Transaction | undefined;
  let barrier: Awaited<ReturnType<typeof acquireLock>> | undefined;
  let registration: Awaited<ReturnType<typeof registerGeneration>> | undefined;
  try {
    await recoverProjection(project);
    const { doc: manifest, text: originalManifest } =
      await readManifest(project);
    const patches = await loadProjectPatches(project);
    const patchDigest = patches.length
      ? sha512Hex(
          canonicalJson(
            patches.map((p) => ({ sourceId: p.sourceId, digest: p.digest })),
          ),
        )
      : undefined;
    const specs = options.specs ?? [];
    const mutation = options.mutation;
    if (mutation?.remove) {
      for (const name of mutation.remove) {
        if (!packageName(name))
          throw error(
            "ZYRK_USAGE",
            "Remove needs valid direct dependency names.",
          );
        let found = false;
        for (const group of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ] as const) {
          if (manifest[group]?.[name] !== undefined) {
            delete manifest[group]![name];
            found = true;
          }
        }
        if (!found)
          throw error(
            "ZYRK_USAGE",
            "Cannot remove a package that is not a direct dependency.",
          );
      }
    }
    const updating = mutation?.update !== undefined;
    const updateNames = new Set(
      mutation?.update?.length
        ? mutation.update
        : Object.keys(requirements(manifest)),
    );
    if (updating)
      for (const name of updateNames)
        if (requirements(manifest)[name] === undefined)
          throw error(
            "ZYRK_USAGE",
            "Cannot update a package that is not a direct dependency.",
          );
    if (
      (options.frozen || options.offline) &&
      (specs.length > 0 || mutation !== undefined)
    )
      throw error(
        "ZYRK_USAGE",
        "Adding package specifications cannot be combined with frozen or offline installation.",
      );
    for (const spec of specs) {
      let parsed: ReturnType<typeof npa>;
      try {
        parsed = npa(spec);
      } catch {
        throw error(
          "ZYRK_USAGE",
          "Cannot parse the requested package specification.",
        );
      }
      if (
        !parsed.name ||
        !packageName(parsed.name) ||
        !["version", "range", "tag", "alias"].includes(parsed.type)
      )
        throw error(
          "ZYRK_USAGE",
          "Install accepts registry packages and npm aliases only.",
        );
      const group = options.saveOptional
        ? "optionalDependencies"
        : options.saveDev
          ? "devDependencies"
          : "dependencies";
      const requested =
        parsed.rawSpec === "" || parsed.rawSpec === "*"
          ? "latest"
          : parsed.rawSpec;
      manifest[group] = { ...manifest[group], [parsed.name]: requested };
      for (const other of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ] as const)
        if (other !== group && manifest[other])
          delete manifest[other]![parsed.name];
    }
    const overrides = createRootOverrides(manifest);
    const allDeps = requirements(manifest);
    for (const [name, spec] of Object.entries(allDeps))
      parseRequirement(name, spec);
    const fingerprints = () => ({
      manifest: manifestFingerprint(manifest),
      scripts: scriptPolicyFingerprint(scriptPolicy(manifest)),
      config: configFingerprint({
        registry: options.registry.origin,
        registries: options.registry.scopedRegistries,
        linker: "shared",
        ...(object(manifest.zyrk) &&
        Array.isArray(manifest.zyrk.mutablePackages)
          ? { mutablePackages: manifest.zyrk.mutablePackages as string[] }
          : {}),
        ...(patchDigest === undefined ? {} : { patches: patchDigest }),
      }),
    });
    const lockPath = path.join(project, "package-lock.json");
    const existing = (
      await readLockfile(lockPath, !options.frozen && !options.offline)
    )?.doc;
    let resolved: FinalizedGraph | undefined;
    if (options.importNpm && (!existing || existing.zyrk))
      throw lockMismatch(
        "import --from npm requires an existing npm-only lockfile",
      );
    if (existing && !existing.zyrk) {
      if (options.frozen || options.offline || specs.length)
        throw lockMismatch(
          "npm-only lockfile requires a non-frozen adoption install before adding packages",
        );
      resolved = importNpmLock(
        existing,
        allDeps,
        (name) => options.registry.originFor(name),
        overrides,
      );
    }
    if (
      existing?.zyrk &&
      specs.length === 0 &&
      !updating &&
      !mutation?.remove?.length
    ) {
      let compatible = true;
      try {
        assertFrozenCompatible(existing, fingerprints());
        if (existing.zyrk?.platformPolicy !== "portable-optional/1")
          throw lockMismatch(
            "lock predates portable platform selections; refresh intentionally",
          );
      } catch (cause) {
        if (options.frozen) throw cause;
        compatible = false;
      }
      if (compatible) resolved = lockedGraph(existing);
    }
    if (!resolved) {
      if (options.frozen) throw lockMismatch("missing compatible lockfile");
      if (options.offline)
        throw error(
          "ZYRK_OFFLINE_MISSING",
          "Offline installation requires an existing compatible zyrk lockfile.",
        );
      const prior =
        existing?.zyrk?.platformPolicy === "portable-optional/1"
          ? lockedGraph(existing)
          : undefined;
      const fresh = new Set(specs.map((spec) => npa(spec).name));
      options.onProgress?.({ phase: "resolving" });
      resolved = await resolveRequirements({
        overrides,
        limits: options.resolveBudget!,
        preservePlatformVariants: true,
        provider: {
          origin: options.registry.origin,
          originFor: (name: string) => options.registry.originFor(name),
          packument: (name) =>
            options.registry.packument(name, {
              signal: operation.operation.signal,
            }),
        },
        requirements: Object.entries(allDeps)
          .map(([name, spec]) => {
            if (updating && updateNames.has(name)) {
              if (mutation?.latest) {
                const parsed = parseRequirement(name, spec);
                return {
                  name,
                  spec:
                    parsed.kind === "alias"
                      ? `npm:${parsed.realName}@latest`
                      : "latest",
                };
              }
              return {
                name,
                spec,
                ...(manifest.optionalDependencies?.[name] === undefined
                  ? {}
                  : { optional: true }),
              };
            }
            const previous = prior?.nodes.find((node) =>
              prior.roots.some(
                (root) => root.name === name && root.target === node.key,
              ),
            );
            const parsed = parseRequirement(name, spec);
            if (
              !fresh.has(name) &&
              previous &&
              previous.name === parsed.realName &&
              parsed.targetKind !== "tag" &&
              satisfies(previous.version, parsed.targetSpec)
            )
              return {
                name,
                spec:
                  parsed.kind === "alias"
                    ? `npm:${previous.name}@${previous.version}`
                    : previous.version,
              };
            return {
              name,
              spec,
              ...(manifest.optionalDependencies?.[name] === undefined
                ? {}
                : { optional: true }),
            };
          })
          .map((requirement) => ({
            ...requirement,
            ...(manifest.optionalDependencies?.[requirement.name] === undefined
              ? {}
              : { optional: true }),
          })),
      });
      if (updating && mutation?.latest)
        for (const name of updateNames) {
          const selected = resolved.nodes.find((node) =>
            resolved!.roots.some(
              (root) => root.name === name && root.target === node.key,
            ),
          );
          if (!selected) throw lockMismatch("updated root disappeared");
          for (const group of [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
          ] as const)
            if (manifest[group]?.[name] !== undefined) {
              const original = parseRequirement(name, manifest[group]![name]!);
              const range = options.saveExact
                ? selected.version
                : `^${selected.version}`;
              manifest[group]![name] =
                original.kind === "alias"
                  ? `npm:${selected.name}@${range}`
                  : range;
            }
        }
    }
    // Save selected tags/bare requests as ranges; never persist an unbound latest.
    for (const spec of specs) {
      const parsed = npa(spec);
      const selected = resolved.nodes.find((n) =>
        resolved!.roots.some(
          (r) => r.name === parsed.name && r.target === n.key,
        ),
      );
      if (!selected || !parsed.name)
        throw error(
          "ZYRK_MANIFEST_INVALID",
          "Resolution lost an explicitly requested package.",
        );
      const group = options.saveOptional
        ? "optionalDependencies"
        : options.saveDev
          ? "devDependencies"
          : "dependencies";
      const declared = manifest[group]?.[parsed.name];
      if (
        declared !== undefined &&
        parsed.type !== "alias" &&
        (parsed.type === "tag" ||
          parsed.type === "version" ||
          parsed.rawSpec === "*")
      )
        manifest[group]![parsed.name] = options.saveExact
          ? selected.version
          : `^${selected.version}`;
    }
    // Validate fresh and locked graphs identically, including URL credentials.
    for (const node of resolved.nodes) {
      if (
        !packageName(node.name) ||
        !cleanUrl(node.origin) ||
        !cleanUrl(node.tarballUrl) ||
        node.origin !== options.registry.originFor(node.name)
      )
        throw error(
          "ZYRK_POLICY_DENIED",
          "Selected source has an unsupported or credential-bearing registry origin or archive URL.",
        );
    }
    const activeResolution = selectPlatformGraph(
      {
        ...resolved,
        roots: resolved.roots.filter(
          (r) =>
            !options.omitDev ||
            manifest.dependencies?.[r.name] !== undefined ||
            manifest.optionalDependencies?.[r.name] !== undefined,
        ),
      },
      new Set(Object.keys(manifest.optionalDependencies ?? {})),
      options.platform,
    );
    const selectedRoots = activeResolution.roots;
    const activeNodes = activeResolution.nodes;
    const byKey = new Map(activeNodes.map((n) => [n.key, n]));
    barrier = await acquireLock(
      path.join(options.store.paths.locksDir, "liveness.lock"),
      { name: "store liveness" },
    );
    txn = await Transaction.begin(options.store, "install");
    const candidateLock = path.join(txn.dir, "package-lock.json");
    const doc =
      options.frozen && existing
        ? existing
        : await writeLockfile({
            path: candidateLock,
            name: typeof manifest.name === "string" ? manifest.name : "",
            version:
              typeof manifest.version === "string" ? manifest.version : "0.0.0",
            manifestDeps: {
              ...manifest.dependencies,
            },
            manifestOptionalDeps: manifest.optionalDependencies ?? {},
            manifestPeerDeps: manifest.peerDependencies ?? {},
            manifestPeerMeta: object(manifest.peerDependenciesMeta)
              ? (manifest.peerDependenciesMeta as Record<
                  string,
                  { optional?: boolean }
                >)
              : {},
            manifestDevDeps: manifest.devDependencies ?? {},
            resolution: resolved,
            fingerprints: fingerprints(),
            existing: existing ?? null,
          });
    const files: Array<{
      name: "package.json" | "package-lock.json";
      contents: string;
    }> = [];
    if (!options.frozen)
      files.push({
        name: "package-lock.json",
        contents: await readFile(candidateLock, "utf8"),
      });
    if (
      specs.length ||
      mutation?.remove?.length ||
      (updating && mutation?.latest)
    )
      files.push({
        name: "package.json",
        contents: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    const warnings: string[] = (activeResolution.omissions ?? []).map(
      (item) =>
        `${item.name}: omitted optional dependency incompatible with the selected platform.`,
    );
    for (const stage of ["preinstall", "install", "postinstall"])
      if (manifest.scripts?.[stage])
        warnings.push(
          `Root ${stage} hook was not run; invoke it explicitly after installation.`,
        );
    if (options.lockfileOnly) {
      // Metadata-only publication uses the same recoverable journal but preserves node_modules.
      await installMetadata(project, files);
      return {
        readiness: "lockfile-only",
        packages: resolved.nodes.length,
        reused: 0,
        warnings,
      };
    }
    await txn.setState("fetching");
    const repairOf = options.repair
      ? selectRealizationDirs(
          options.store,
          createGraphDoc(
            activeNodes.map((node) => ({ ...node, deps: node.edges })),
          ),
        )
      : undefined;
    const repair = options.repair
      ? await prepareRepair({
          store: options.store,
          graphNodes: activeNodes,
          offline: options.offline === true,
        })
      : undefined;
    const unique = new Map(activeNodes.map((n) => [n.sourceId, n]));
    const progress = sourceProgress(options.onProgress, unique.size);
    options.onProgress?.({
      phase: "fetching",
      completed: 0,
      total: unique.size,
    });
    for (const node of unique.values()) {
      operation.operation.checkpoint();
      if (await pathExists(sourceManifestPath(options.store, node.sourceId))) {
        await readSourceManifest(options.store, node.sourceId);
        progress.verified(node, "reused");
        continue;
      }
      if (options.offline)
        throw error(
          "ZYRK_OFFLINE_MISSING",
          `Verified source for ${node.name}@${node.version} is missing from the store.`,
        );
      const tarball = path.join(txn.dir, `${node.sourceId}.tgz`);
      const downloadProgress = progress.downloading(node);
      const download = await options.registry
        .forPackage(node.name)
        .downloadTarball({
          signal: operation.operation.signal,
          onBytes(bytes) {
            operation.operation.consumeArchiveBytes(bytes);
            downloadProgress(bytes);
          },
          url: node.tarballUrl,
          expectedIntegrity: node.integrity,
          destPath: tarball,
          label: `${node.name}@${node.version}`,
        });
      const extracted = await extractTarball({
        limits: options.extractBudget!,
        signal: operation.operation.signal,
        onExpandedBytes: operation.operation.consumeExpandedBytes,
        tarballPath: tarball,
        destDir: path.join(txn.dir, node.sourceId),
      });
      const source = await commitExtractedSource({
        store: options.store,
        extraction: extracted,
        name: node.name,
        version: node.version,
        origin: node.origin,
        integrity: download.verifiedSri,
        archiveBytes: download.bytes,
      });
      if (source.sourceId !== node.sourceId)
        throw lockMismatch(
          "download identity disagrees with the locked source",
        );
      await rm(tarball, { force: true });
      progress.verified(node, "downloaded");
    }
    for (const node of unique.values())
      assertSupportedSourcePayload(
        node,
        await readSourceManifest(options.store, node.sourceId),
      );
    await txn.setState("sources-committed");
    if (options.fetchOnly)
      return {
        readiness: "fetched",
        packages: activeNodes.length,
        reused: 0,
        warnings,
      };
    const graph = createGraphDoc(
      activeNodes.map((n) => ({ ...n, deps: n.edges })),
    );
    options.onProgress?.({ phase: "realizing" });
    const sharedRealized = await realizeGraph({
      store: options.store,
      graph,
      ...(repair ? { instanceSuffix: repair.instanceSuffix } : {}),
    });
    let realized = sharedRealized;
    const generationId = `gen1_${randomId("", 12)}`;
    let privateGraph = false;
    if (patches.length) {
      realized = await materializePrivate({
        project,
        store: options.store,
        graph,
        generationId,
      });
      privateGraph = true;
      const applied = await applyProjectPatches({
        project,
        store: options.store,
        packages: new Map(
          activeNodes.map((n) => [
            n.key,
            {
              sourceId: n.sourceId,
              directory: realized.packageDirByKey.get(n.key)!,
            },
          ]),
        ),
      });
      if (applied.digest !== patchDigest)
        throw new ZyrkError(
          "ZYRK_LOCK_MISMATCH",
          "Patch artifacts changed during installation.",
          {
            remedy:
              "Review the changed patch artifacts and retry; no dependency scripts were executed.",
          },
        );
    }
    const builds = await candidates(activeNodes, realized.packageDirByKey);
    const reviewedDigest = candidateDigest(
      graph,
      builds,
      scriptPolicy(manifest),
      patchDigest ?? "",
    );
    if (options.reviewBuilds) {
      await writeFileAtomic(
        path.join(project, ".zyrk-local", "build-candidate.json"),
        JSON.stringify({ schemaVersion: 1, candidate: reviewedDigest, builds }),
        { mode: 0o600 },
      );
      if (options.approveBuilds)
        await approveCandidate({
          project,
          digest: reviewedDigest,
          builds,
          selected: options.approveBuilds,
          env: options.env ?? process.env,
          policy: scriptPolicy(manifest),
        });
      return {
        readiness: "build-review",
        packages: activeNodes.length,
        reused: sharedRealized.reused.length,
        warnings,
        candidateDigest: reviewedDigest,
        builds,
      };
    }
    const unbuilt = builds.length > 0 && options.ignoreScripts === true;
    if (builds.length && !options.ignoreScripts) {
      await assertApproved({
        project,
        env: options.env ?? process.env,
        digest: reviewedDigest,
        builds,
        policy: scriptPolicy(manifest),
      });
      if (!privateGraph) {
        realized = await materializePrivate({
          project,
          store: options.store,
          graph,
          generationId,
        });
        privateGraph = true;
      }
      options.onProgress?.({ phase: "building" });
      await buildPrivate({
        project,
        generationId,
        nodes: activeNodes,
        builds,
        realized,
        env: options.env ?? process.env,
      });
    }
    const mutable = object(manifest.zyrk)
      ? manifest.zyrk.mutablePackages
      : undefined;
    if (mutable !== undefined) {
      if (!Array.isArray(mutable) || mutable.some((v) => typeof v !== "string"))
        throw error(
          "ZYRK_POLICY_DENIED",
          "mutablePackages must be an array of selected package names or source identities.",
        );
      for (const rule of mutable)
        if (!activeNodes.some((n) => n.name === rule || n.sourceId === rule))
          throw error(
            "ZYRK_POLICY_DENIED",
            "A mutable package selector does not match the selected graph.",
          );
      if (mutable.length && !privateGraph) {
        realized = await materializePrivate({
          project,
          store: options.store,
          graph,
          generationId,
        });
        privateGraph = true;
      }
    }
    if (unbuilt)
      for (const build of builds)
        warnings.push(
          `${build.name}@${build.version}: skipped ${build.stages.map((s) => s.name).join(", ")}; intentionally unbuilt.`,
        );
    if (privateGraph)
      warnings.push(
        "Using a complete project-private dependency graph; build/runtime writes do not change shared source.",
      );
    const entries: ProjectionEntry[] = selectedRoots.map((r) => ({
      name: r.name,
      linkTarget: realized.packageDirByKey.get(r.target)!,
    }));
    const bins: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const r of selectedRoots) {
      const node = byKey.get(r.target)!;
      const dir = realized.packageDirByKey.get(r.target)!;
      for (const [name, target] of Object.entries(node.bin)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
          throw error(
            "ZYRK_MANIFEST_INVALID",
            "A dependency declares an unsafe executable name.",
          );
        const script = path.resolve(dir, target);
        const actual = await realpath(script).catch(() => "");
        if (
          !actual.startsWith(`${dir}${path.sep}`) ||
          !(await lstat(actual)).isFile()
        )
          throw error(
            "ZYRK_MANIFEST_INVALID",
            "A dependency executable is missing or escapes its package.",
          );
        if (bins[name] && bins[name] !== script)
          throw error(
            "ZYRK_MANIFEST_INVALID",
            `Direct dependencies declare conflicting executable ${name}.`,
          );
        // Never chmod a shared inode. A shell shim executes non-executable JS with Node.
        bins[name] = script;
      }
    }
    // The durable root exists before links publish; interrupted installs may retain an extra root.
    const projectId = `project1_${sha512Hex(project).slice(0, 32)}`;
    const digest = graphHash(graph);
    await writeFileAtomic(
      path.join(options.store.paths.graphsDir, `${digest}.json`),
      JSON.stringify(graph),
      { mode: 0o600 },
    );
    await writeFileAtomic(
      path.join(options.store.paths.pinsDir, `${projectId}-${digest}.json`),
      JSON.stringify({
        kind: "generation",
        projectId,
        project,
        graph: digest,
        instances: [...sharedRealized.realizationDirByKey.values()],
        sources: [...unique.keys()],
      }),
      { mode: 0o600 },
    );
    if (
      (await readFile(path.join(project, "package.json"), "utf8")) !==
      originalManifest
    )
      throw lockMismatch("package.json changed while installation was running");
    await txn.setState("committing");
    const readiness = unbuilt
      ? ("intentionally-unbuilt" as const)
      : ("ready" as const);
    registration = await registerGeneration({
      store: options.store,
      project,
      projectId,
      generationId,
      graph,
      realized,
      sharedRealized,
      ...(repairOf === undefined ? {} : { repairOf }),
      roots: selectedRoots.map((r) => r.target),
      readiness,
    });
    options.onProgress?.({ phase: "linking" });
    const published = await installProjection(project, entries, {
      generationId,
      lockHeld: true,
      projectId,
      bins,
      files,
      readiness,
      metadata: {
        linker: privateGraph ? "private" : "shared",
        privateDir: privateGraph
          ? path.join(project, ".zyrk-local", "generations", generationId)
          : null,
        buildProfile: privateGraph
          ? {
              node: process.version,
              abi: process.versions.modules,
              platform: process.platform,
              arch: process.arch,
              candidate: reviewedDigest,
              patches: patchDigest ?? null,
            }
          : null,
        storeRoot: options.store.paths.root,
        instances: registration.instances,
        activeContexts: registration.contexts,
        lockDigest: sha512Hex(canonicalJson(doc)),
        registryConfig: {
          registry: options.registry.origin,
          registries: options.registry.scopedRegistries,
        },
        graphDigest: digest,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        contexts: [...realized.realizationDirByKey.keys()],
      },
    });
    registration.activate();
    await txn.setState("committed");
    reportLinked(options.onProgress, activeNodes);
    return {
      readiness,
      packages: activeNodes.length,
      reused: realized.reused.length,
      warnings,
      generationId: published.generationId,
    };
  } catch (cause) {
    await recoverProjection(project);
    throw cause;
  } finally {
    operation.close();
    registration?.close();
    try {
      if (txn) await txn.finish();
    } finally {
      await barrier?.release();
      await held.release();
    }
  }
}
