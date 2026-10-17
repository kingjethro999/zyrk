/** Self-contained pure-package deployment and explicit local Docker commands. */
import { constants } from "node:fs";
import {
  open,
  copyFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { findProjectBoundary, resolveStoreRoot } from "../config/paths.ts";
import { ZyrkError, type ErrorCode } from "../errors.ts";
import { lockedGraph } from "../install/lock.ts";
import { loadProjectPatches } from "./patch.ts";
import { currentPlatform } from "../resolve/resolver.ts";
import { openStoreDb } from "../store/db.ts";
import { validateLockDoc, assertFrozenCompatible } from "../lockfile/read.ts";
import {
  manifestFingerprint,
  scriptPolicyFingerprint,
  configFingerprint,
  type ManifestDeclaration,
} from "../lockfile/fingerprints.ts";
import {
  createGraphDoc,
  contextIdFor,
  graphHash,
  type GraphDoc,
} from "../store/graph.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { packageDirIn, selectRealizationDirs } from "../store/realize.ts";
import { verifyRealization } from "../store/verify.ts";
import { sha512Hex, sha512HexOfFile } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { acquireLock } from "../util/locks.ts";
import { superviseChild } from "../util/proc.ts";

type Obj = Record<string, unknown>;
function object(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function error(code: ErrorCode, message: string): ZyrkError {
  return new ZyrkError(code, message, {
    remedy:
      "Select explicit runtime files and a direct Node entry, install a ready graph, and use a new output directory.",
  });
}
export type DeployCommandOptions = {
  command: "deploy" | "docker";
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  json?: boolean;
};
function flags(args: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const item = args[i]!;
    const split = item.indexOf("=");
    const key = split < 0 ? item : item.slice(0, split);
    const value = split < 0 ? args[++i] : item.slice(split + 1);
    if (!key.startsWith("--") || !value || value.startsWith("--"))
      throw error(
        "ZYRK_USAGE",
        "Docker/deploy options require explicit values.",
      );
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}
function one(f: Map<string, string[]>, key: string): string | undefined {
  const values = f.get(key);
  if ((values?.length ?? 0) > 1)
    throw error("ZYRK_USAGE", "An option was supplied more than once.");
  return values?.[0];
}
function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
function relativeFile(value: string): string {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).some((p) => !p || p === "." || p === "..") ||
    /[\0\r\n*?\[\]]/.test(value)
  )
    throw error(
      "ZYRK_USAGE",
      "Runtime file selections must be concrete safe project-relative paths.",
    );
  return value;
}
function sensitive(name: string): boolean {
  return (
    /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git|\.zyrk-local|node_modules|\.ssh)$/i.test(
      name,
    ) || /\.(?:pem|key|p12|pfx)$/i.test(name)
  );
}
async function readJson(file: string): Promise<Obj> {
  try {
    const doc: unknown = JSON.parse(await readFile(file, "utf8"));
    if (object(doc)) return doc;
  } catch {}
  throw error(
    "ZYRK_MANIFEST_INVALID",
    "Cannot read deployment project metadata.",
  );
}
function output(options: DeployCommandOptions, result: Obj, human: string) {
  options.stdout.write(
    options.json
      ? JSON.stringify({
          schemaVersion: 1,
          command: options.command,
          ...result,
        }) + "\n"
      : human + "\n",
  );
}

export async function runDeployCommand(
  options: DeployCommandOptions,
): Promise<number> {
  const boundary = await findProjectBoundary(options.cwd);
  if (!boundary)
    throw error("ZYRK_MANIFEST_INVALID", "Cannot find a project to deploy.");
  const project = await realpath(boundary);
  const manifest = await readJson(path.join(project, "package.json"));
  if (options.command === "docker") return docker(options, project, manifest);
  const f = flags(options.args);
  for (const key of f.keys())
    if (!["--out", "--omit", "--files", "--entry"].includes(key))
      throw error("ZYRK_USAGE", "Unknown deploy option.");
  if (one(f, "--omit") !== undefined && one(f, "--omit") !== "dev")
    throw error("ZYRK_USAGE", "Deploy supports only --omit=dev.");
  const destination = one(f, "--out");
  if (!destination)
    throw error("ZYRK_USAGE", "Deploy requires --out <new-directory>.");
  const out = path.resolve(options.cwd, destination);
  if (out === project || within(out, project))
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Deployment output overlaps the project input.",
    );
  const parent = await realpath(path.dirname(out)).catch(() => {
    throw error("ZYRK_USAGE", "Deployment output parent must already exist.");
  });
  const actualOut = path.join(parent, path.basename(out));
  if (actualOut !== out || actualOut === project || within(actualOut, project))
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Deployment output resolves through a link or overlaps project input.",
    );
  if (await lstat(out).catch(() => null))
    throw error(
      "ZYRK_USAGE",
      "Deployment output already exists; choose a new directory.",
    );
  const files = runtimeFiles(f, manifest);
  const entry = entryFile(f, manifest);
  if (!files.some((file) => within(file, entry)))
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "The Node entry is absent from the selected runtime files.",
    );
  for (const file of files)
    if (
      within(path.join(project, file), out) ||
      within(out, path.join(project, file))
    )
      throw error(
        "ZYRK_DEPLOY_ESCAPE",
        "Deployment output overlaps selected runtime files.",
      );
  const control = await lstat(path.join(project, ".zyrk-local")).catch(
    () => null,
  );
  if (control && (!control.isDirectory() || control.isSymbolicLink()))
    throw error("ZYRK_STORE_CORRUPT", "Project control directory is unsafe.");
  const projectLock = await acquireLock(
    path.join(project, ".zyrk-local/project.lock"),
    { name: "portable deployment" },
  );
  try {
    const state = await readJson(
      path.join(project, "node_modules/.zyrk/install-state.json"),
    );
    const rawLock = await readJson(path.join(project, "package-lock.json"));
    if (
      manifest.workspaces !== undefined ||
      (object(rawLock.zyrk) && rawLock.zyrk.version === 2)
    )
      throw error(
        "ZYRK_DEPLOY_NONRELOCATABLE",
        "Workspace runtime exports require a validated live-importer deployment adapter.",
      );
    const doc = validateLockDoc(rawLock, "project package-lock.json");
    const resolved = lockedGraph(doc);
    const privateGraph = state.linker === "private";
    if (state.readiness !== "ready")
      throw error(
        "ZYRK_SCRIPT_BLOCKED",
        "Cannot export an unready or intentionally unbuilt generation.",
      );
    if (
      state.lockDigest !== sha512Hex(canonicalJson(doc)) ||
      doc.zyrk?.manifest !==
        manifestFingerprint(manifest as ManifestDeclaration)
    )
      throw error(
        "ZYRK_LOCK_MISMATCH",
        "Deployment manifest, lock, and installed generation disagree.",
      );
    if (resolved.nodes.length) {
      const origins = new Set(resolved.nodes.map((node) => node.origin));
      if (origins.size !== 1)
        throw error(
          "ZYRK_DEPLOY_NONRELOCATABLE",
          "Mixed-origin deployment requires a validated registry adapter.",
        );
      const patches = await loadProjectPatches(project);
      const policy = object(manifest.zyrk) ? manifest.zyrk : {};
      assertFrozenCompatible(doc, {
        manifest: manifestFingerprint(manifest as ManifestDeclaration),
        scripts: scriptPolicyFingerprint(policy.scripts),
        config: configFingerprint({
          registry: [...origins][0]!,
          linker: "shared",
          platform: currentPlatform(),
          ...(Array.isArray(policy.mutablePackages)
            ? { mutablePackages: policy.mutablePackages as string[] }
            : {}),
          ...(patches.length
            ? {
                patches: sha512Hex(
                  canonicalJson(
                    patches.map((p) => ({
                      sourceId: p.sourceId,
                      digest: p.digest,
                    })),
                  ),
                ),
              }
            : {}),
        }),
      });
    }
    if (state.platform !== process.platform || state.arch !== process.arch)
      throw error(
        "ZYRK_PLATFORM_UNSUPPORTED",
        "Deployment requires artifacts for the current platform and architecture.",
      );
    const store = await Store.open({
      root: resolveStoreRoot({ env: options.env }).root,
    });
    store.requireInitialized();
    const barrier = await acquireLock(
      path.join(store.paths.locksDir, "liveness.lock"),
      { name: "portable deployment retention" },
    );
    try {
      const installedKeys = new Set(
        Array.isArray(state.contexts)
          ? state.contexts.filter((v): v is string => typeof v === "string")
          : [],
      );
      const installedNodes = resolved.nodes.filter((n) =>
        installedKeys.has(n.key),
      );
      const graph = createGraphDoc(
        installedNodes.map((n) => ({ ...n, deps: n.edges })),
      );
      const directories = privateGraph
        ? await privateDirectories(project, store, graph, state)
        : selectRealizationDirs(store, graph);
      const selectedRoots: Record<string, string> = {};
      const declarations = {
        ...(object(manifest.dependencies) ? manifest.dependencies : {}),
        ...(object(manifest.optionalDependencies)
          ? manifest.optionalDependencies
          : {}),
      };
      for (const name of Object.keys(declarations)) {
        const key = doc.zyrk?.roots["."]?.[name];
        if (key && installedKeys.has(key)) selectedRoots[name] = key;
        else if (
          !object(manifest.optionalDependencies) ||
          manifest.optionalDependencies[name] === undefined
        )
          throw error(
            "ZYRK_OFFLINE_MISSING",
            "A required runtime dependency is not installed.",
          );
      }
      const selected = new Set<string>();
      const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
      const visit = (key: string) => {
        if (selected.has(key)) return;
        selected.add(key);
        const node = byKey.get(key);
        if (!node)
          throw error(
            "ZYRK_OFFLINE_MISSING",
            "A runtime dependency edge is missing.",
          );
        for (const edge of node.edges) visit(edge.target);
      };
      Object.values(selectedRoots).forEach(visit);
      if (privateGraph)
        await validatePrivateProjection(
          project,
          graph,
          directories,
          selected,
          selectedRoots,
        );
      else
        for (const key of selected)
          await verifyRealization({
            store,
            graph,
            rootKey: key,
            contextId: contextIdFor(graph, key),
            realizationDirs: directories,
          });
      const stage = await mkdtemp(path.join(parent, ".zyrk-deploy-"));
      try {
        for (const file of files)
          await copyApplication(
            path.join(project, file),
            path.join(stage, file),
            project,
          );
        const deployedManifest = { ...manifest };
        delete deployedManifest.devDependencies;
        delete deployedManifest.zyrk;
        delete deployedManifest.packageManager;
        await writeFile(
          path.join(stage, "package.json"),
          JSON.stringify(deployedManifest, null, 2) + "\n",
        );
        const packageDirs = new Map<string, string>();
        const privateBudget = { entries: 0, bytes: 0, started: Date.now() };
        for (const key of selected) {
          const node = byKey.get(key)!;
          const context = contextIdFor(graph, key);
          const sourceDir = packageDirIn(directories.get(key)!, node.name);
          const targetDir = packageDirIn(
            path.join(stage, "node_modules/.zyrk/portable", context),
            node.name,
          );
          packageDirs.set(key, targetDir);
          await mkdir(targetDir, { recursive: true });
          if (privateGraph) {
            const nestedSlots = new Set<string>();
            const names = new Set([node.name]);
            for (const edge of node.edges) {
              if (names.has(edge.name))
                nestedSlots.add(
                  path.join("node_modules", ...edge.name.split("/")),
                );
              names.add(edge.name);
            }
            await copyPrivatePayload(
              sourceDir,
              targetDir,
              sourceDir,
              targetDir,
              nestedSlots,
              [project, store.root],
              privateBudget,
            );
            continue;
          }
          const source = await readSourceManifest(store, node.sourceId);
          for (const e of source.manifest.entries) {
            const target = path.join(targetDir, e.path);
            if (!within(targetDir, target))
              throw error(
                "ZYRK_DEPLOY_ESCAPE",
                "A dependency source path escapes its portable package.",
              );
            await mkdir(path.dirname(target), { recursive: true });
            if (e.type === "dir") await mkdir(target, { recursive: true });
            else if (e.type === "symlink") {
              if (
                path.isAbsolute(e.target) ||
                !within(targetDir, path.resolve(path.dirname(target), e.target))
              )
                throw error(
                  "ZYRK_DEPLOY_ESCAPE",
                  "A package symlink escapes its portable package.",
                );
              await symlink(e.target, target);
            } else {
              if (e.path.endsWith(".node"))
                throw error(
                  "ZYRK_DEPLOY_NONRELOCATABLE",
                  "Native addon runtime compatibility requires a validated deployment adapter.",
                );
              await copyFile(path.join(sourceDir, e.path), target);
              await chmod(target, e.mode === "exec" ? 0o755 : 0o644);
            }
          }
        }
        for (const key of selected) {
          const node = byKey.get(key)!,
            pkg = packageDirs.get(key)!;
          for (const edge of node.edges) {
            const modules =
              edge.name === node.name
                ? path.join(pkg, "node_modules")
                : path.dirname(
                    node.name.startsWith("@") ? path.dirname(pkg) : pkg,
                  );
            await relativeLink(
              path.join(modules, edge.name),
              packageDirs.get(edge.target)!,
            );
          }
        }
        for (const [name, key] of Object.entries(selectedRoots))
          await relativeLink(
            path.join(stage, "node_modules", name),
            packageDirs.get(key)!,
          );
        // Local launchers are recomputed from selected roots; their targets stay portable.
        for (const [name, key] of Object.entries(selectedRoots)) {
          const node = doc.zyrk!.nodes[key]!;
          for (const [bin, target] of Object.entries(node.bin ?? {})) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bin))
              throw error(
                "ZYRK_DEPLOY_ESCAPE",
                "Unsafe executable name in portable graph.",
              );
            const file = path.resolve(packageDirs.get(key)!, target);
            if (!within(packageDirs.get(key)!, file))
              throw error(
                "ZYRK_DEPLOY_ESCAPE",
                "Portable executable escapes its package.",
              );
            const stat = await lstat(file).catch(() => null);
            if (!stat?.isFile())
              throw error(
                "ZYRK_DEPLOY_NONRELOCATABLE",
                "A required package executable is missing.",
              );
            if ((stat.mode & 0o111) !== 0)
              await relativeLink(
                path.join(stage, "node_modules/.bin", bin),
                file,
              );
            else {
              await mkdir(path.join(stage, "node_modules/.bin"), {
                recursive: true,
              });
              const rel = path
                .relative(path.join(stage, "node_modules/.bin"), file)
                .split(path.sep)
                .join("/");
              await writeFile(
                path.join(stage, "node_modules/.bin", bin),
                '#!/bin/sh\nexec node "$(dirname "$0")"/' +
                  shellQuote(rel) +
                  ' "$@"\n',
                { mode: 0o755 },
              );
            }
          }
          void name;
        }
        const entryStat = await lstat(path.join(stage, entry)).catch(
          () => null,
        );
        if (!entryStat?.isFile())
          throw error(
            "ZYRK_DEPLOY_NONRELOCATABLE",
            "The selected runtime Node entry is missing.",
          );
        if (privateGraph)
          await scanPrivateExport(stage, [project, store.root], privateBudget);
        await validateLinks(stage, stage);
        await writeFile(
          path.join(stage, "zyrk-deploy.json"),
          JSON.stringify(
            {
              schemaVersion: 1,
              platform: process.platform,
              arch: process.arch,
              node: process.version,
              entry: ["node", entry],
              requirements: ["Node.js " + process.versions.node.split(".")[0]],
              packages: selected.size,
              files,
              validation: "structural; application smoke test not run",
            },
            null,
            2,
          ) + "\n",
        );
        await rename(stage, out);
        output(
          options,
          {
            packages: selected.size,
            entry: ["node", entry],
            validation: "structural",
          },
          `Exported ${selected.size} runtime dependencies. Start with: node ${entry}. Structural validation passed; no application smoke test ran.`,
        );
        return 0;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } finally {
      await barrier.release();
    }
  } finally {
    await projectLock.release();
  }
}
function runtimeFiles(f: Map<string, string[]>, manifest: Obj): string[] {
  const raw = f.get("--files") ?? manifest.files;
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.some((v) => typeof v !== "string")
  )
    throw error(
      "ZYRK_USAGE",
      "Declare runtime files with repeated --files paths or a package.json files array.",
    );
  return [...new Set(raw.map((v) => relativeFile(String(v))))];
}
function entryFile(f: Map<string, string[]>, manifest: Obj): string {
  let entry = one(f, "--entry");
  if (
    !entry &&
    object(manifest.scripts) &&
    typeof manifest.scripts.start === "string"
  )
    entry = /^node\s+([a-zA-Z0-9_./-]+)$/.exec(manifest.scripts.start)?.[1];
  if (!entry)
    throw error(
      "ZYRK_USAGE",
      "Choose a direct Node runtime entry with --entry <project-relative-file>.",
    );
  return relativeFile(entry);
}
async function copyApplication(
  source: string,
  target: string,
  project: string,
): Promise<void> {
  if (path.relative(project, source).split(path.sep).some(sensitive))
    throw error(
      "ZYRK_POLICY_DENIED",
      "A runtime file selection includes credentials, control state, or development dependencies.",
    );
  const stat = await lstat(source).catch(() => null);
  if (!stat)
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "A selected runtime file is missing.",
    );
  if (
    stat.isSymbolicLink() ||
    (await realpath(source).catch(() => null)) !== source
  )
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Application runtime selections must contain real files and directories without linked ancestors.",
    );
  if (stat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source))
      await copyApplication(
        path.join(source, name),
        path.join(target, name),
        project,
      );
  } else if (stat.isFile()) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, stat.mode & 0o111 ? 0o755 : 0o644);
  } else
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Special files cannot be exported as application files.",
    );
}
async function relativeLink(link: string, target: string) {
  await mkdir(path.dirname(link), { recursive: true });
  const existing = await lstat(link).catch(() => null);
  if (existing) {
    if (
      existing.isSymbolicLink() &&
      (await readlink(link)) === path.relative(path.dirname(link), target)
    )
      return;
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "Conflicting dependency or executable slots exist in the runtime graph.",
    );
  }
  await symlink(path.relative(path.dirname(link), target), link);
}
async function validateLinks(root: string, dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name),
      stat = await lstat(file);
    if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      if (
        path.isAbsolute(target) ||
        !within(root, path.resolve(path.dirname(file), target)) ||
        !within(root, await realpath(file))
      )
        throw error(
          "ZYRK_DEPLOY_ESCAPE",
          "A portable link escapes the deployment boundary.",
        );
    } else if (stat.isDirectory()) await validateLinks(root, file);
  }
}
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function docker(
  options: DeployCommandOptions,
  project: string,
  manifest: Obj,
): Promise<number> {
  const operation = options.args[0];
  if (!["init", "build", "run"].includes(operation ?? ""))
    throw error("ZYRK_USAGE", "Select docker init, build, or run.");
  const f = flags(options.args.slice(1));
  if (operation === "init") {
    for (const key of f.keys())
      if (
        ![
          "--node-image",
          "--cli-artifact",
          "--cli-sha512",
          "--build-script",
          "--entry",
          "--files",
          "--port",
        ].includes(key)
      )
        throw error("ZYRK_USAGE", "Unknown docker init option.");
    const image = one(f, "--node-image");
    if (
      !image ||
      !/^node:(?:24|26)[a-zA-Z0-9._-]*@sha256:[0-9a-f]{64}$/.test(image)
    )
      throw error(
        "ZYRK_USAGE",
        "Docker init requires a supported Node image pinned by sha256 digest.",
      );
    const artifact = relativeFile(one(f, "--cli-artifact") ?? "");
    const digest = one(f, "--cli-sha512");
    if (!digest || !/^[0-9a-f]{128}$/.test(digest))
      throw error(
        "ZYRK_USAGE",
        "Docker init requires the pinned CLI artifact sha512 digest.",
      );
    const actual = await realpath(path.join(project, artifact)).catch(() => {
      throw error("ZYRK_USAGE", "The pinned CLI artifact is missing.");
    });
    if (!within(project, actual) || (await sha512HexOfFile(actual)) !== digest)
      throw error(
        "ZYRK_INTEGRITY_FAILED",
        "The pinned CLI artifact failed its project boundary or digest check.",
      );
    const entry = entryFile(f, manifest),
      files = runtimeFiles(f, manifest);
    if (!files.some((file) => within(file, entry)))
      throw error(
        "ZYRK_DEPLOY_NONRELOCATABLE",
        "The runtime entry must belong to the selected production file set.",
      );
    const build = one(f, "--build-script");
    if (
      build &&
      (!object(manifest.scripts) || typeof manifest.scripts[build] !== "string")
    )
      throw error(
        "ZYRK_USAGE",
        "The selected Docker build script is not declared.",
      );
    const portText = one(f, "--port") ?? "3000";
    if (
      !/^\d+$/.test(portText) ||
      Number(portText) < 1 ||
      Number(portText) > 65535
    )
      throw error("ZYRK_USAGE", "Choose a runtime port between 1 and 65535.");
    const artifactJson = JSON.stringify([artifact, "/tmp/zyrk-cli.tgz"]);
    const deployArgs =
      files.map((file) => " --files " + shellQuote(file)).join("") +
      " --entry " +
      shellQuote(entry);
    const dockerfile = `# syntax=docker/dockerfile:1\n# Generated inputs are recorded in zyrk-docker.json; review before building.\nFROM ${image} AS build\nWORKDIR /app\nCOPY ${artifactJson}\nRUN echo '${digest}  /tmp/zyrk-cli.tgz' | sha512sum --check - && npm install --global /tmp/zyrk-cli.tgz && rm /tmp/zyrk-cli.tgz\nENV ZYRK_STORE_DIR=/zyrk-store\nCOPY . .\nRUN --mount=type=secret,id=npmrc,target=/root/.npmrc zyrk fetch --frozen-lockfile\nRUN --network=none zyrk install --frozen-lockfile --offline${build ? " && zyrk run " + shellQuote(build) : ""} && zyrk deploy --out /runtime-output --omit=dev${deployArgs}\nFROM ${image} AS runtime\nWORKDIR /app\nENV NODE_ENV=production\nCOPY --from=build --chown=node:node /runtime-output/ /app/\nUSER node\nEXPOSE ${portText}\nCMD ${JSON.stringify(["node", entry])}\n`;
    const contents: Record<string, string> = {
      Dockerfile: dockerfile,
      ".dockerignore":
        "node_modules\n.git\n.env\n.env.*\n**/.env\n**/.env.*\n.npmrc\n**/.npmrc\n.netrc\n**/.netrc\n**/*.pem\n**/*.key\n.zyrk-local\ndist-runtime\nnpm-debug.log*\n",
      "zyrk-docker.json":
        JSON.stringify(
          {
            schemaVersion: 1,
            nodeImage: image,
            cliArtifact: artifact,
            cliSha512: digest,
            entry,
            files,
            buildScript: build ?? null,
            port: Number(portText),
          },
          null,
          2,
        ) + "\n",
      "ZYRK_DOCKER.md": `Review Dockerfile and .dockerignore before building. Runtime files: ${files.join(", ")}. Runtime entry: node ${entry}. Build script: ${build ?? "none"}. Container port: ${portText}.\n\nThe pinned CLI tarball must remain at its declared path. Dependencies are fetched with an optional BuildKit npmrc secret, then installed, built, and exported without networking or registry secrets. No host node_modules or store enters the runtime image. Adapt build inputs and credential exclusions to your project; generated files do not prove application health. Relocatable JavaScript output from ready private generations is supported, including patches and approved build output. Native outputs, embedded host paths, live workspace exports, and arbitrary shell start commands require a validated adapter and are rejected by this generic exporter.\n\nBuild: zyrk docker build --tag your-app:local\nRun: zyrk docker run --tag your-app:local --port ${portText}\nSupply private registry credentials to Docker BuildKit directly with docker build --secret id=npmrc,src=<credential-file> when required; zyrk never embeds them.\n`,
    };
    for (const name of Object.keys(contents))
      if (await lstat(path.join(project, name)).catch(() => null))
        throw error(
          "ZYRK_USAGE",
          "Docker setup files already exist; review or move them before generating new files.",
        );
    const created: string[] = [];
    try {
      for (const [name, content] of Object.entries(contents)) {
        await writeFile(path.join(project, name), content, {
          flag: "wx",
          mode: 0o644,
        });
        created.push(name);
      }
    } catch (cause) {
      for (const name of created) await rm(path.join(project, name));
      throw cause;
    }
    output(
      options,
      {
        files: Object.keys(contents),
        entry: ["node", entry],
        port: Number(portText),
        nodeImage: image,
      },
      `Created reviewable Docker setup files. Runtime: node ${entry}; port ${portText}; image ${image}. Build script: ${build ?? "none"}.`,
    );
    return 0;
  }
  for (const key of f.keys())
    if (
      !["--tag", "--port"].includes(key) ||
      (operation === "build" && key === "--port")
    )
      throw error("ZYRK_USAGE", "Unknown Docker build/run option.");
  const tag = one(f, "--tag");
  if (
    !tag ||
    !/^([a-zA-Z0-9][a-zA-Z0-9._/-]*)(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/.test(
      tag,
    )
  )
    throw error(
      "ZYRK_USAGE",
      "Docker build/run requires an explicit local image --tag.",
    );
  const config = await readJson(path.join(project, "zyrk-docker.json"));
  if (
    config.schemaVersion !== 1 ||
    typeof config.port !== "number" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    throw error(
      "ZYRK_MANIFEST_INVALID",
      "Docker runtime declaration is invalid.",
    );
  const args =
    operation === "build"
      ? ["build", "--tag", tag, "."]
      : [
          "run",
          "--rm",
          "--publish",
          `${one(f, "--port") ?? String(config.port)}:${config.port}`,
          tag,
        ];
  if (
    operation === "run" &&
    !/^\d{1,5}$/.test(one(f, "--port") ?? String(config.port))
  )
    throw error("ZYRK_USAGE", "Choose an explicit numeric host port.");
  const code = await subprocess(options, "docker", args, project, {
    ...options.env,
    DOCKER_BUILDKIT: "1",
  });
  if (code === 0)
    output(
      options,
      { operation, tag, exitCode: code },
      `Docker ${operation} completed for ${tag}. Application health was not tested.`,
    );
  return code;
}
async function subprocess(
  options: DeployCommandOptions,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  try {
    const result = await superviseChild(command, args, {
      cwd,
      env,
      stdout: options.stdout,
      stderr: options.stderr,
    });
    return result.exitCode;
  } catch {
    throw error(
      "ZYRK_BUILD_FAILED",
      "Cannot launch Docker; install the Docker CLI and enable a reachable BuildKit-capable daemon.",
    );
  }
}

async function privateDirectories(
  project: string,
  store: Store,
  graph: GraphDoc,
  state: Obj,
): Promise<Map<string, string>> {
  const profile = state.buildProfile;
  if (
    !object(profile) ||
    typeof state.generationId !== "string" ||
    !/^gen1_[a-z2-7]+$/.test(state.generationId) ||
    typeof state.projectId !== "string"
  )
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "Private generation has no supported build profile or selected identity.",
    );
  if (
    profile.node !== process.version ||
    profile.abi !== process.versions.modules ||
    profile.platform !== process.platform ||
    profile.arch !== process.arch
  )
    throw error(
      "ZYRK_PLATFORM_UNSUPPORTED",
      "Private export requires its exact recorded Node, ABI, platform and architecture.",
    );
  if (
    typeof profile.candidate !== "string" ||
    !/^[0-9a-f]{128}$/.test(profile.candidate) ||
    state.graphDigest !== graphHash(graph) ||
    state.storeRoot !== store.root
  )
    throw error(
      "ZYRK_STORE_CORRUPT",
      "Private generation profile does not match its selected graph and store.",
    );
  const base = path.join(
    project,
    ".zyrk-local",
    "generations",
    state.generationId,
  );
  if (
    state.privateDir !== base ||
    !Array.isArray(state.instances) ||
    state.instances.some((id) => typeof id !== "string")
  )
    throw error(
      "ZYRK_STORE_CORRUPT",
      "Private generation instance selection is invalid.",
    );
  const db = openStoreDb(store.paths.dbFile);
  const directories = new Map<string, string>();
  try {
    const generation = db
      .prepare(
        "SELECT graph_digest,readiness,state FROM generations WHERE generation_id=? AND project_id=?",
      )
      .get(state.generationId, state.projectId) as
      { graph_digest: string; readiness: string; state: string } | undefined;
    if (
      !generation ||
      generation.graph_digest !== graphHash(graph) ||
      generation.readiness !== "ready" ||
      generation.state !== "active"
    )
      throw error(
        "ZYRK_STORE_CORRUPT",
        "Private deployment requires the active ready generation recorded by the project.",
      );
    const rows = db
      .prepare(
        "SELECT gi.context_id,ri.instance_id,ri.path FROM generation_instances gi JOIN realization_instances ri ON gi.instance_id=ri.instance_id WHERE gi.generation_id=? AND ri.verification_state='verified'",
      )
      .all(state.generationId) as Array<{
      context_id: string;
      instance_id: string;
      path: string;
    }>;
    const ids = new Set(state.instances as string[]);
    if (
      rows.length !== ids.size ||
      rows.some((row) => !ids.has(row.instance_id))
    )
      throw error(
        "ZYRK_STORE_CORRUPT",
        "Private generation instance metadata disagrees with the selected projection.",
      );
    const byContext = new Map(rows.map((row) => [row.context_id, row.path]));
    for (const node of graph.nodes) {
      const directory = path.join(base, contextIdFor(graph, node.key));
      if (byContext.get(contextIdFor(graph, node.key)) !== directory)
        throw error(
          "ZYRK_DEPLOY_ESCAPE",
          "Private context path is outside its exact selected generation.",
        );
      directories.set(node.key, directory);
      const pkg = packageDirIn(directory, node.name);
      const ancestors = [
        path.join(project, ".zyrk-local"),
        path.join(project, ".zyrk-local/generations"),
        base,
        directory,
        path.join(directory, "node_modules"),
        ...(node.name.startsWith("@") ? [path.dirname(pkg)] : []),
        pkg,
      ];
      for (const ancestor of ancestors) {
        const metadata = await lstat(ancestor).catch(() => null);
        if (!metadata?.isDirectory() || metadata.isSymbolicLink())
          throw error(
            "ZYRK_DEPLOY_ESCAPE",
            "Private generation passes through an unexpected link or missing directory.",
          );
      }
    }
  } finally {
    db.close();
  }
  return directories;
}

async function validatePrivateProjection(
  project: string,
  graph: GraphDoc,
  directories: ReadonlyMap<string, string>,
  selected: ReadonlySet<string>,
  roots: Readonly<Record<string, string>>,
): Promise<void> {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const check = async (slot: string, target: string): Promise<void> => {
    const metadata = await lstat(slot).catch(() => null);
    if (
      !metadata?.isSymbolicLink() ||
      (await realpath(slot).catch(() => null)) !== target
    )
      throw error(
        "ZYRK_DEPLOY_ESCAPE",
        "Private dependency projection does not select its recorded context.",
      );
  };
  for (const [name, key] of Object.entries(roots))
    await check(
      path.join(project, "node_modules", name),
      packageDirIn(directories.get(key)!, nodes.get(key)!.name),
    );
  for (const key of selected) {
    const node = nodes.get(key)!;
    const pkg = packageDirIn(directories.get(key)!, node.name);
    const names = new Set([node.name]);
    for (const edge of node.edges) {
      const target = nodes.get(edge.target)!;
      const slot = names.has(edge.name)
        ? path.join(pkg, "node_modules", ...edge.name.split("/"))
        : path.join(
            directories.get(key)!,
            "node_modules",
            ...edge.name.split("/"),
          );
      await check(
        slot,
        packageDirIn(directories.get(target.key)!, target.name),
      );
      names.add(edge.name);
    }
  }
}

type PrivateBudget = { entries: number; bytes: number; started: number };
function checkPrivateBudget(budget: PrivateBudget): void {
  if (
    budget.entries > 200_000 ||
    budget.bytes > 4 * 1024 * 1024 * 1024 ||
    Date.now() - budget.started > 120_000
  )
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "Private deployment exceeds its file, byte or duration budget.",
    );
}
function nativeMagic(buffer: Buffer): boolean {
  const magic = buffer.subarray(0, 4).toString("hex");
  return (
    [
      "7f454c46",
      "feedface",
      "cefaedfe",
      "feedfacf",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
    ].includes(magic) || buffer.subarray(0, 2).toString("ascii") === "MZ"
  );
}
async function scanOrCopyPrivateFile(
  source: string,
  target: string | undefined,
  forbidden: readonly string[],
  budget: PrivateBudget,
): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const metadata = await input.stat();
    if (!metadata.isFile())
      throw error(
        "ZYRK_DEPLOY_ESCAPE",
        "Private payload contains a special filesystem entry.",
      );
    if (/\.node$/i.test(source))
      throw error(
        "ZYRK_DEPLOY_NONRELOCATABLE",
        "Native dependency outputs require a validated export adapter.",
      );
    if (target !== undefined)
      output = await open(target, "wx", metadata.mode & 0o111 ? 0o755 : 0o644);
    const needles = [
      ...new Set(
        forbidden.flatMap((value) => [
          value,
          JSON.stringify(value).slice(1, -1),
        ]),
      ),
    ].map((value) => Buffer.from(value));
    // Keep enough overlap to detect credential markers split across read chunks.
    const overlap = Math.max(4096, ...needles.map((value) => value.length));
    let previous = Buffer.alloc(0);
    let first = true;
    let fileBytes = 0;
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const bytes = chunk.subarray(0, bytesRead);
      fileBytes += bytesRead;
      budget.bytes += bytesRead;
      checkPrivateBudget(budget);
      if (fileBytes > 512 * 1024 * 1024)
        throw error(
          "ZYRK_DEPLOY_NONRELOCATABLE",
          "A private generated file exceeds the deployment byte budget.",
        );
      if (first && nativeMagic(bytes))
        throw error(
          "ZYRK_DEPLOY_NONRELOCATABLE",
          "Native dependency outputs require a validated export adapter.",
        );
      first = false;
      const inspect = Buffer.concat([previous, bytes]);
      if (needles.some((needle) => inspect.includes(needle)))
        throw error(
          "ZYRK_DEPLOY_NONRELOCATABLE",
          "Private output embeds an absolute host project or store path.",
        );
      if (
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|https?:\/\/[^\s/@]+:[^\s/@]+@|["']?_(?:authToken|auth|password)["']?\s*[:=]\s*["']?[^\s"';,}]+/i.test(
          inspect.toString("utf8"),
        )
      )
        throw error(
          "ZYRK_DEPLOY_NONRELOCATABLE",
          "Private output contains credential-like content.",
        );
      previous = Buffer.from(
        inspect.subarray(Math.max(0, inspect.length - overlap)),
      );
      if (output) {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await output.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (!written.bytesWritten)
            throw error(
              "ZYRK_DEPLOY_NONRELOCATABLE",
              "Cannot finish copying private dependency output.",
            );
          offset += written.bytesWritten;
        }
      }
    }
  } finally {
    await input.close();
    await output?.close();
  }
}
async function copyPrivatePayload(
  source: string,
  target: string,
  sourceRoot: string,
  targetRoot: string,
  skip: ReadonlySet<string>,
  forbidden: readonly string[],
  budget: PrivateBudget,
): Promise<void> {
  const metadata = await lstat(source);
  budget.entries++;
  checkPrivateBudget(budget);
  const relative = path.relative(sourceRoot, source);
  if (skip.has(relative)) return;
  const name = path.basename(source);
  if (relative && name !== "node_modules" && sensitive(name))
    throw error(
      "ZYRK_DEPLOY_NONRELOCATABLE",
      "Private dependency output contains a credential or host configuration filename.",
    );
  if (metadata.isSymbolicLink()) {
    const actual = await realpath(source).catch(() => null);
    if (actual === null || !within(sourceRoot, actual))
      throw error(
        "ZYRK_DEPLOY_ESCAPE",
        "Private payload link escapes its package or has no stable target.",
      );
    const mapped = path.join(targetRoot, path.relative(sourceRoot, actual));
    await symlink(path.relative(path.dirname(target), mapped) || ".", target);
    return;
  }
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of (await readdir(source)).sort())
      await copyPrivatePayload(
        path.join(source, name),
        path.join(target, name),
        sourceRoot,
        targetRoot,
        skip,
        forbidden,
        budget,
      );
    return;
  }
  if (!metadata.isFile())
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Private payload contains a special filesystem entry.",
    );
  await mkdir(path.dirname(target), { recursive: true });
  await scanOrCopyPrivateFile(source, target, forbidden, budget);
}
async function scanPrivateExport(
  root: string,
  forbidden: readonly string[],
  budget: PrivateBudget,
): Promise<void> {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const metadata = await lstat(file);
    budget.entries++;
    checkPrivateBudget(budget);
    if (metadata.isDirectory())
      await scanPrivateExport(file, forbidden, budget);
    else if (metadata.isFile())
      await scanOrCopyPrivateFile(file, undefined, forbidden, budget);
  }
}
