/** Self-contained pure-package deployment and explicit local Docker commands. */
import { spawn } from "node:child_process";
import {
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
import { validateLockDoc } from "../lockfile/read.ts";
import {
  manifestFingerprint,
  type ManifestDeclaration,
} from "../lockfile/fingerprints.ts";
import { createGraphDoc, contextIdFor, type GraphDoc } from "../store/graph.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { packageDirIn, realizationDirFor } from "../store/realize.ts";
import { verifyRealization } from "../store/verify.ts";
import { sha512Hex, sha512HexOfFile } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { acquireLock } from "../util/locks.ts";
import { closeCode } from "../util/proc.ts";

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
    const doc = validateLockDoc(
      await readJson(path.join(project, "package-lock.json")),
      "project package-lock.json",
    );
    const resolved = lockedGraph(doc);
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
      for (const key of selected)
        await verifyRealization({
          store,
          graph,
          rootKey: key,
          contextId: contextIdFor(graph, key),
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
        for (const key of selected) {
          const node = byKey.get(key)!;
          const context = contextIdFor(graph, key);
          const sourceDir = packageDirIn(
            realizationDirFor(store, context),
            node.name,
          );
          const targetDir = packageDirIn(
            path.join(stage, "node_modules/.zyrk/portable", context),
            node.name,
          );
          packageDirs.set(key, targetDir);
          await mkdir(targetDir, { recursive: true });
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
  if (stat.isSymbolicLink())
    throw error(
      "ZYRK_DEPLOY_ESCAPE",
      "Application runtime selections must contain real files and directories.",
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
      "ZYRK_DOCKER.md": `Review Dockerfile and .dockerignore before building. Runtime files: ${files.join(", ")}. Runtime entry: node ${entry}. Build script: ${build ?? "none"}. Container port: ${portText}.\n\nThe pinned CLI tarball must remain at its declared path. Dependencies are fetched with an optional BuildKit npmrc secret, then installed, built, and exported without networking or registry secrets. No host node_modules or store enters the runtime image. Adapt build inputs and credential exclusions to your project; generated files do not prove application health. Native/private build adapters and arbitrary shell start commands are not supported by this generic exporter.\n\nBuild: zyrk docker build --tag your-app:local\nRun: zyrk docker run --tag your-app:local --port ${portText}\nSupply private registry credentials to Docker BuildKit directly with docker build --secret id=npmrc,src=<credential-file> when required; zyrk never embeds them.\n`,
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
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c: Buffer) => options.stdout.write(c.toString()));
    child.stderr?.on("data", (c: Buffer) => options.stderr.write(c.toString()));
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    const listeners = signals.map((sig) => {
      const listener = () => {
        child.kill(sig);
      };
      process.on(sig, listener);
      return [sig, listener] as const;
    });
    child.once("error", () =>
      reject(
        error(
          "ZYRK_BUILD_FAILED",
          "Cannot launch Docker; install the Docker CLI and enable a reachable BuildKit-capable daemon.",
        ),
      ),
    );
    child.once("close", (code, signal) => {
      for (const [sig, listener] of listeners) process.off(sig, listener);
      resolve(closeCode(code, signal));
    });
  });
}
