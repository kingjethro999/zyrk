/** Explicit Next.js configuration editing; ordinary installs never call this. */
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { satisfies } from "semver";
import { findProjectBoundary, resolveStoreRoot } from "../config/paths.ts";
import { ZyrkError } from "../errors.ts";
import { lockedGraph } from "../install/lock.ts";
import { selectPlatformGraph } from "../install/platform.ts";
import { validateLockDoc } from "../lockfile/read.ts";
import { manifestFingerprint } from "../lockfile/fingerprints.ts";
import { Store } from "../store/layout.ts";
import { createGraphDoc, contextIdFor } from "../store/graph.ts";
import { packageDirIn, selectRealizationDirs } from "../store/realize.ts";
import { verifyRealization } from "../store/verify.ts";
import { acquireLock } from "../util/locks.ts";
import { isErrno, writeFileAtomic } from "../util/fsx.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";

const HELPER = "next.config.zyrk-turbopack.cjs";
const DECLARATION = "next.config.zyrk-turbopack.d.cts";
const MARKER =
  "// Managed by explicit zyrk next --turbopack; original configuration is preserved.\n";
const TYPES =
  "declare function withZyrkTurbopack<T>(configuration: T, projectDir: string): T;\nexport = withZyrkTurbopack;\n";
const RUNTIME = `// Local paths are discovered at Next startup, never committed into configuration.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const canonical = value => JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
module.exports = (configuration, directory) => async (phase, context) => {
  if (process.platform === "win32") throw new Error("zyrk Turbopack Windows support has not passed its compatibility gate.");
  const project = fs.realpathSync(directory);
  const state = JSON.parse(fs.readFileSync(path.join(project, "node_modules/.zyrk/install-state.json"), "utf8"));
  if (state.schemaVersion !== 1 || state.readiness !== "ready" || state.linker !== "shared" || typeof state.storeRoot !== "string" || !path.isAbsolute(state.storeRoot)) throw new Error("zyrk Turbopack requires a ready shared installation; run zyrk install.");
  const lock = JSON.parse(fs.readFileSync(path.join(project, "package-lock.json"), "utf8"));
  if (crypto.createHash("sha512").update(canonical(lock)).digest("hex") !== state.lockDigest) throw new Error("zyrk Turbopack installation and lock disagree; run zyrk install.");
  const next = fs.realpathSync(path.join(project, "node_modules/next"));
  const version = JSON.parse(fs.readFileSync(path.join(next, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !/^16\\.(?:[4-9]|[1-9][0-9]+)\\.[0-9]+$/.test(version)) throw new Error("zyrk Turbopack additional roots require stable Next.js 16.4.x through 16.x.");
  const store = fs.realpathSync(path.join(state.storeRoot, "realizations"));
  const direct = Array.isArray(state.direct) && state.direct.find(edge => edge.name === "next");
  if (!direct || fs.realpathSync(direct.target) !== next || !inside(store, next) || inside(project, store) || inside(store, project)) throw new Error("zyrk Turbopack requires the recorded external shared dependency projection.");
  const resolved = await (typeof configuration === "function" ? configuration(phase, context) : configuration);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) throw new Error("The original Next configuration must return an object.");
  const roots = resolved.experimental?.turbopackAdditionalRoots || {};
  if (roots.zyrkStore && fs.realpathSync(roots.zyrkStore.path) !== store) throw new Error("The existing zyrkStore Turbopack root conflicts with the installed store.");
  return { ...resolved, turbopack: { ...resolved.turbopack, root: project }, experimental: { ...resolved.experimental, turbopackAdditionalRoots: { ...roots, zyrkStore: { path: store } } } };
};
`;
function denied(message: string): ZyrkError {
  return new ZyrkError("ZYRK_USAGE", message, {
    remedy:
      "Run zyrk next --turbopack in a ready shared Next.js 16.4+ project; restore or review existing configuration files before retrying.",
  });
}
async function regular(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw denied("Next configuration editing requires regular files.");
}
function wrapper(name: string, esm: boolean): string {
  const original = name.replace(/\.(ts|mjs|js)$/, ".zyrk-original.$1");
  if (!esm)
    return `${MARKER}module.exports = require("./${HELPER}")(require("./${original}"), __dirname);\n`;
  const importedOriginal = name.endsWith(".ts")
    ? original.slice(0, -3)
    : original;
  const directory =
    name.endsWith(".mjs") || name.endsWith(".js")
      ? 'fileURLToPath(new URL(".", import.meta.url))'
      : "__dirname";
  return `${MARKER}${directory === "__dirname" ? "" : 'import { fileURLToPath } from "node:url";\n'}import original from "./${importedOriginal}";\nimport withZyrkTurbopack from "./${HELPER}";\n\nexport default withZyrkTurbopack(original, ${directory});\n`;
}
export async function runNextCommand(options: {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; config: string; backup: string }> {
  if (process.platform === "win32")
    throw new ZyrkError(
      "ZYRK_PLATFORM_UNSUPPORTED",
      "Next Turbopack configuration is not verified on Windows.",
      {
        remedy:
          "Use a platform with a verified zyrk store; Windows support remains gated.",
      },
    );
  if (options.args.length !== 1 || options.args[0] !== "--turbopack")
    throw denied(
      "Next configuration editing requires the explicit --turbopack option.",
    );
  const boundary = await findProjectBoundary(options.cwd);
  if (!boundary) throw denied("Cannot find a Next project manifest.");
  const project = await realpath(boundary);
  const control = await lstat(path.join(project, ".zyrk-local"));
  if (!control.isDirectory() || control.isSymbolicLink())
    throw denied("Next project control directory is unsafe.");
  const held = await acquireLock(
    path.join(project, ".zyrk-local/project.lock"),
    { name: "Next Turbopack configuration" },
  );
  try {
    const state = JSON.parse(
      await readFile(
        path.join(project, "node_modules/.zyrk/install-state.json"),
        "utf8",
      ),
    );
    const doc = validateLockDoc(
      JSON.parse(
        await readFile(path.join(project, "package-lock.json"), "utf8"),
      ),
      "project package-lock.json",
    );
    if (
      state.schemaVersion !== 1 ||
      state.readiness !== "ready" ||
      state.linker !== "shared" ||
      state.lockDigest !== sha512Hex(canonicalJson(doc))
    )
      throw denied(
        "Next configuration requires a ready shared installation matching its lock.",
      );
    const manifest = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    );
    if (doc.zyrk?.manifest !== manifestFingerprint(manifest))
      throw denied(
        "The Next project manifest differs from its installed lock.",
      );
    const resolved = lockedGraph(doc);
    const selected = selectPlatformGraph(
      {
        ...resolved,
        roots: resolved.roots.filter(
          (root) =>
            Array.isArray(state.direct) &&
            state.direct.some(
              (edge: { name: string }) => edge.name === root.name,
            ),
        ),
      },
      new Set(
        Object.keys((doc.packages?.[""]?.optionalDependencies as object) ?? {}),
      ),
    );
    const next = selected.nodes.find(
      (node) =>
        node.name === "next" &&
        selected.roots.some(
          (root) => root.name === "next" && root.target === node.key,
        ),
    );
    if (!next || !satisfies(next.version, ">=16.4.0 <17.0.0"))
      throw denied(
        "The additional-root adapter requires stable Next.js 16.4.x through 16.x.",
      );
    const store = await Store.open({
      root: resolveStoreRoot({ env: options.env }).root,
    });
    store.requireInitialized();
    if (state.storeRoot !== store.root)
      throw denied(
        "The installed Next store differs from the selected user store.",
      );
    const storeRealizations = await realpath(store.paths.realizationsDir);
    const contains = (root: string, file: string): boolean => {
      const relative = path.relative(root, file);
      return (
        relative === "" ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    };
    if (
      contains(project, storeRealizations) ||
      contains(storeRealizations, project)
    )
      throw denied(
        "The Turbopack adapter requires shared realizations outside the project root.",
      );
    const graph = createGraphDoc(
      selected.nodes.map((node) => ({ ...node, deps: node.edges })),
    );
    const directories = selectRealizationDirs(store, graph);
    await verifyRealization({
      store,
      graph,
      rootKey: next.key,
      contextId: contextIdFor(graph, next.key),
      realizationDirs: directories,
    });
    if (
      (await realpath(path.join(project, "node_modules/next"))) !==
      (await realpath(packageDirIn(directories.get(next.key)!, "next")))
    )
      throw denied(
        "The installed Next link differs from its verified context.",
      );
    const names = (await readdir(project)).filter((name) =>
      ["next.config.ts", "next.config.js", "next.config.mjs"].includes(name),
    );
    if (names.length !== 1)
      throw denied(
        "Select a project with exactly one supported Next configuration file.",
      );
    const name = names[0]!;
    const original = name.replace(/\.(ts|mjs|js)$/, ".zyrk-original.$1");
    const target = path.join(project, name);
    await regular(target);
    const contents = await readFile(target, "utf8");
    const generated = wrapper(
      name,
      name !== "next.config.js" || manifest.type === "module",
    );
    if (contents === generated) {
      for (const file of [original, HELPER, DECLARATION])
        await regular(path.join(project, file));
      if (
        (await readFile(path.join(project, HELPER), "utf8")) !== RUNTIME ||
        (await readFile(path.join(project, DECLARATION), "utf8")) !== TYPES
      )
        throw denied(
          "The existing Turbopack adapter was changed; review it before retrying.",
        );
      return { changed: false, config: name, backup: original };
    }
    const created: string[] = [];
    let configWriteAttempted = false;
    try {
      await copyFile(
        target,
        path.join(project, original),
        constants.COPYFILE_EXCL,
      );
      created.push(original);
      await chmod(path.join(project, original), 0o444);
      for (const [file, text] of [
        [HELPER, RUNTIME],
        [DECLARATION, TYPES],
      ] as const) {
        await writeFile(path.join(project, file), text, { flag: "wx" });
        created.push(file);
      }
      configWriteAttempted = true;
      await writeFileAtomic(target, generated);
    } catch (cause) {
      // The atomic write may have renamed successfully before a durability
      // error. Retain its dependencies and original backup for recovery.
      if (!configWriteAttempted)
        for (const file of created.reverse())
          await rm(path.join(project, file)).catch(() => {});
      if (isErrno(cause, "EEXIST"))
        throw denied(
          "A Next configuration backup or adapter already exists; no existing files were overwritten.",
        );
      throw cause;
    }
    return { changed: true, config: name, backup: original };
  } finally {
    await held.release();
  }
}
