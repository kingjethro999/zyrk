import { registerGeneration } from "./metadata.ts";
import { randomId } from "../util/ids.ts";
import { importNpmLock } from "./import-npm.ts";
/** Native project install: resolve -> verify -> realize -> journaled publication. */
import { readFile, realpath, lstat, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import npa from "npm-package-arg";
import { satisfies } from "semver";
import { ZyrkError } from "../errors.ts";
import { RegistryClient } from "../fetch/registry.ts";
import { extractTarball } from "../extract/tarball.ts";
import { commitExtractedSource } from "../store/source.ts";
import { Store } from "../store/layout.ts";
import { Transaction } from "../store/txn.ts";
import { readSourceManifest, sourceManifestPath } from "../store/manifests.ts";
import { realizeGraph } from "../store/realize.ts";
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

export type InstallOptions = {
  projectDir: string;
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
};
export type InstallResult = {
  readiness: "ready" | "intentionally-unbuilt" | "lockfile-only" | "fetched";
  packages: number;
  reused: number;
  warnings: string[];
  generationId?: string;
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
    doc.overrides !== undefined ||
    doc.bundledDependencies !== undefined ||
    doc.bundleDependencies !== undefined
  )
    throw error(
      "ZYRK_NOT_IMPLEMENTED",
      "Project workspaces, overrides, and bundled dependencies are not supported by install yet.",
    );
  if (
    doc.zyrk !== undefined &&
    (!object(doc.zyrk) ||
      Object.keys(doc.zyrk).some(
        (key) => !["scripts", "audit"].includes(key),
      ) ||
      (doc.zyrk.scripts !== undefined &&
        canonicalJson(doc.zyrk.scripts) !==
          canonicalJson({ default: "deny", allow: [], deny: [] })))
  )
    throw error(
      "ZYRK_POLICY_DENIED",
      "Project zyrk policy contains unsupported settings; lifecycle approval and mutable-package configuration are not implemented yet.",
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
  const project = await realpath(options.projectDir);
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
  let txn: Transaction | undefined;
  let barrier: Awaited<ReturnType<typeof acquireLock>> | undefined;
  let registration: Awaited<ReturnType<typeof registerGeneration>> | undefined;
  try {
    await recoverProjection(project);
    const { doc: manifest, text: originalManifest } =
      await readManifest(project);
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
    const allDeps = requirements(manifest);
    for (const [name, spec] of Object.entries(allDeps))
      parseRequirement(name, spec);
    const fingerprints = () => ({
      manifest: manifestFingerprint(manifest),
      scripts: scriptPolicyFingerprint(scriptPolicy(manifest)),
      config: configFingerprint({
        registry: options.registry.origin,
        linker: "shared",
      }),
    });
    const lockPath = path.join(project, "package-lock.json");
    const existing = (await readLockfile(lockPath))?.doc;
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
      resolved = importNpmLock(existing, allDeps, options.registry.origin);
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
      const prior = existing?.zyrk ? lockedGraph(existing) : undefined;
      const fresh = new Set(specs.map((spec) => npa(spec).name));
      resolved = await resolveRequirements({
        provider: options.registry,
        requirements: Object.entries(allDeps).map(([name, spec]) => {
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
            return { name, spec };
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
          return { name, spec };
        }),
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
        node.origin !== options.registry.origin
      )
        throw error(
          "ZYRK_POLICY_DENIED",
          "Selected source has an unsupported or credential-bearing registry origin or archive URL.",
        );
    }
    const selectedRoots = resolved.roots.filter(
      (r) =>
        !options.omitDev ||
        manifest.dependencies?.[r.name] !== undefined ||
        manifest.optionalDependencies?.[r.name] !== undefined,
    );
    const byKey = new Map(resolved.nodes.map((n) => [n.key, n]));
    const activeKeys = new Set<string>();
    const visit = (key: string): void => {
      if (activeKeys.has(key)) return;
      activeKeys.add(key);
      const n = byKey.get(key);
      if (!n) throw lockMismatch("missing selected node");
      for (const e of n.edges) visit(e.target);
    };
    for (const r of selectedRoots) visit(r.target);
    const activeNodes = resolved.nodes.filter((n) => activeKeys.has(n.key));
    for (const n of activeNodes) {
      for (const [list, current] of [
        [n.platform.os, process.platform],
        [n.platform.cpu, process.arch],
      ] as const) {
        if (
          list &&
          (list.includes(`!${current}`) ||
            (list.some((x) => !x.startsWith("!")) &&
              !list.includes(current) &&
              !list.includes("any")))
        )
          throw new ZyrkError(
            "ZYRK_PLATFORM_UNSUPPORTED",
            `Cannot install ${n.name}@${n.version} on the selected platform.`,
            { remedy: "Select a package version supporting this OS and CPU." },
          );
      }
      if (n.platform.libc?.length)
        throw error(
          "ZYRK_NOT_IMPLEMENTED",
          "libc-constrained packages require platform selection support that is not implemented yet.",
        );
      if (n.engines?.node && !satisfies(process.versions.node, n.engines.node))
        throw new ZyrkError(
          "ZYRK_PLATFORM_UNSUPPORTED",
          `Cannot install ${n.name}@${n.version} on this Node.js version.`,
          {
            remedy:
              "Use a Node.js version satisfying the package's engines.node range.",
          },
        );
    }
    barrier = await acquireLock(
      path.join(options.store.paths.locksDir, "liveness.lock"),
      { name: "store liveness" },
    );
    txn = await Transaction.begin(options.store, "install");
    const candidateLock = path.join(txn.dir, "package-lock.json");
    const doc = await writeLockfile({
      path: candidateLock,
      name: typeof manifest.name === "string" ? manifest.name : "",
      version:
        typeof manifest.version === "string" ? manifest.version : "0.0.0",
      manifestDeps: {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      },
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
    const warnings: string[] = [];
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
    const unique = new Map(activeNodes.map((n) => [n.sourceId, n]));
    for (const node of unique.values()) {
      if (await pathExists(sourceManifestPath(options.store, node.sourceId))) {
        await readSourceManifest(options.store, node.sourceId);
        continue;
      }
      if (options.offline)
        throw error(
          "ZYRK_OFFLINE_MISSING",
          `Verified source for ${node.name}@${node.version} is missing from the store.`,
        );
      const tarball = path.join(txn.dir, `${node.sourceId}.tgz`);
      const download = await options.registry.downloadTarball({
        url: node.tarballUrl,
        expectedIntegrity: node.integrity,
        destPath: tarball,
        label: `${node.name}@${node.version}`,
      });
      const extracted = await extractTarball({
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
    }
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
    const realized = await realizeGraph({ store: options.store, graph });
    let unbuilt = false;
    for (const node of activeNodes) {
      const dir = realized.packageDirByKey.get(node.key)!;
      let pkg: unknown;
      try {
        pkg = JSON.parse(
          await readFile(path.join(dir, "package.json"), "utf8"),
        );
      } catch {
        throw error(
          "ZYRK_MANIFEST_INVALID",
          "A selected package has no readable package.json.",
        );
      }
      if (
        !object(pkg) ||
        pkg.name !== node.name ||
        pkg.version !== node.version
      )
        throw error(
          "ZYRK_MANIFEST_INVALID",
          "A package archive disagrees with its selected name or version.",
        );
      const scripts = object(pkg.scripts) ? pkg.scripts : {};
      const stages = ["preinstall", "install", "postinstall"].filter(
        (stage) => typeof scripts[stage] === "string" && scripts[stage].trim(),
      );
      if (await pathExists(path.join(dir, "binding.gyp")))
        stages.push("binding.gyp");
      if (stages.length) {
        if (!options.ignoreScripts)
          throw new ZyrkError(
            "ZYRK_SCRIPT_BLOCKED",
            `Installation of ${node.name}@${node.version} is blocked by dependency build policy (${stages.join(", ")}).`,
            {
              remedy:
                "Review the dependency; --ignore-scripts explicitly installs it as intentionally unbuilt. Approved private builds are not implemented yet.",
            },
          );
        unbuilt = true;
        warnings.push(
          `${node.name}@${node.version}: skipped ${stages.join(", ")}; intentionally unbuilt.`,
        );
      }
    }
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
        instances: [...realized.realizationDirByKey.values()],
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
    const generationId = `gen1_${randomId("", 12)}`;
    registration = await registerGeneration({
      store: options.store,
      project,
      projectId,
      generationId,
      graph,
      realized,
      roots: selectedRoots.map((r) => r.target),
      readiness,
    });
    const published = await installProjection(project, entries, {
      generationId,
      lockHeld: true,
      projectId,
      bins,
      files,
      readiness,
      metadata: {
        storeRoot: options.store.paths.root,
        instances: registration.instances,
        activeContexts: registration.contexts,
        lockDigest: sha512Hex(canonicalJson(doc)),
        graphDigest: digest,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        contexts: [...realized.realizationDirByKey.keys()],
      },
    });
    registration.activate();
    await txn.setState("committed");
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
    registration?.close();
    try {
      if (txn) await txn.finish();
    } finally {
      await barrier?.release();
      await held.release();
    }
  }
}
