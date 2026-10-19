/**
 * Temporary tool environments: `zyrk dlx <spec> [args...]` (SPEC 22.4).
 *
 * A tool specifier resolves to an exact package identity; its closure is
 * fetched, verified, and realized through the shared store (reused across
 * runs by exact graph identity, never a mutable `latest`); the tool binary
 * runs in the caller's working directory with a temporary projection outside
 * the store. A durable lease names its exact physical instances, and the
 * publication/GC barrier is held until child shutdown and projection cleanup.
 *
 * Trust policy is honored strictly: dependency lifecycle scripts are denied
 * by default, and no script runner exists yet, so any tool closure
 * declaring install-time scripts fails with ZYRK_SCRIPT_BLOCKED instead of
 * running anything.
 */

import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  stat,
  open,
  readdir,
} from "node:fs/promises";
import npa from "npm-package-arg";
import * as os from "node:os";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { fetchSources } from "../fetch/all.ts";
import type { RegistryClient } from "../fetch/registry.ts";
import type { Logger } from "../log.ts";
import { installProjection } from "../project/projection.ts";
import { createGraphDoc } from "../store/graph.ts";
import type { Store } from "../store/layout.ts";
import { packageDirIn, realizeGraph } from "../store/realize.ts";
import {
  resolveRequirements,
  type ResolvedOccurrence,
} from "../resolve/resolver.ts";
import { Transaction } from "../store/txn.ts";
import { rmrfNoFollow } from "../util/fsx.ts";
import { currentProcessIdentity, superviseChild } from "../util/proc.ts";
import { acquireLock } from "../util/locks.ts";
import { registerGeneration } from "../install/metadata.ts";
import { openStoreDb } from "../store/db.ts";
import { installBudgets } from "../install/budgets.ts";
import { materializePrivate } from "../install/private.ts";
import { randomId } from "../util/ids.ts";

export type DlxOptions = {
  store: Store;
  registry: RegistryClient;
  /** Tool specifier: name[@version|range|tag], possibly an npm alias. */
  spec: string;
  /** Arguments forwarded to the tool binary. */
  args?: readonly string[];
  /** Working directory for the tool (default: current directory). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit bin name; otherwise auto-selected (single or package-named). */
  binName?: string;
  /** Capture stdio instead of inheriting it (used by tests). */
  capture?: boolean;
  logger?: Logger;
  /** Adapter contract checked against the exact resolved tool before execution. */
  validateTool?: (tool: { name: string; version: string }) => void;
};

export type DlxResult = {
  exitCode: number;
  key: string;
  name: string;
  version: string;
  /** True when every needed shared realization already existed. */
  reused: boolean;
  stdout: string;
  stderr: string;
  /** Removed temp environment path (assertable, always deleted). */
  envDir: string;
};

/** Split a tool specifier into its edge name and version part. */
export function splitDlxSpec(spec: string): {
  name: string;
  versionSpec: string;
} {
  const invalid = (cause?: unknown): ZyrkError =>
    new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `invalid tool specifier "${spec}"`,
      {
        detail: { spec },
        remedy: "use a package name with an optional @version, @range, or @tag",
        ...(cause === undefined ? {} : { cause }),
      },
    );
  let parsed: { name: unknown };
  try {
    parsed = npa(spec);
  } catch (error) {
    throw invalid(error);
  }
  if (typeof parsed.name !== "string" || parsed.name === "") throw invalid();
  if (spec === parsed.name) return { name: parsed.name, versionSpec: "" };
  if (!spec.startsWith(`${parsed.name}@`)) throw invalid();
  return { name: parsed.name, versionSpec: spec.slice(parsed.name.length + 1) };
}

export async function runDlx(options: DlxOptions): Promise<DlxResult> {
  return runTemporaryTool(options, false);
}

/** Initializers copy and rewrite their shipped templates, so their full
 * closure must use independent writable files (I-001, I-002, F-017). */
export async function runInitializer(options: DlxOptions): Promise<DlxResult> {
  return runTemporaryTool(options, true);
}

async function runTemporaryTool(
  options: DlxOptions,
  writable: boolean,
): Promise<DlxResult> {
  const { store, registry } = options;
  const args = options.args ?? [];
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const split = splitDlxSpec(options.spec);
  const resolved = await resolveRequirements({
    provider: registry,
    limits: installBudgets(env).resolveBudget!,
    requirements: [{ name: split.name, spec: split.versionSpec }],
  });
  const root = resolved.roots.find((entry) => entry.name === split.name);
  if (root === undefined)
    throw internal(`resolution lost the root for "${options.spec}"`);
  const byKey = new Map(resolved.nodes.map((node) => [node.key, node]));
  const tool = byKey.get(root.target);
  if (tool === undefined) throw internal(`resolution lost node ${root.target}`);
  options.validateTool?.({ name: tool.name, version: tool.version });

  // Retain the publication/GC barrier until the child and temporary projection
  // are gone. The durable lease additionally protects recovery after a crash.
  const barrier = await acquireLock(
    path.join(store.paths.locksDir, "liveness.lock"),
    { name: "temporary tool liveness" },
  );
  let txn: Transaction | undefined;
  let envDir: string | undefined;
  try {
    txn = await Transaction.begin(store, "dlx");
    await txn.setState("fetching");
    const fetched = await fetchSources({
      store,
      registry,
      txn,
      requests: resolved.nodes.map((node) => ({
        key: node.key,
        name: node.name,
        version: node.version,
      })),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    for (const node of resolved.nodes) {
      const committed = fetched.get(node.key);
      if (committed === undefined) throw internal(`fetch lost ${node.key}`);
      if (committed.sourceId !== node.sourceId) {
        throw new ZyrkError(
          "ZYRK_INTERNAL",
          `fetch skew for ${node.name}@${node.version}: resolved and committed identities disagree`,
          {
            detail: { name: node.name, version: node.version },
            remedy:
              "retry the operation; registries must serve immutable versioned content",
          },
        );
      }
    }
    await txn.setState("sources-committed");

    const graph = createGraphDoc(
      resolved.nodes.map((node) => ({
        key: node.key,
        name: node.name,
        version: node.version,
        sourceId: node.sourceId,
        deps: node.edges.map((edge) => ({
          name: edge.name,
          target: edge.target,
        })),
      })),
    );
    const sharedRealized = await realizeGraph({
      store,
      graph,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await txn.setState("realizations-ready");

    await assertNoInstallScripts(sharedRealized.packageDirByKey, byKey);
    envDir = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-"));
    const generationId = randomId("gen1_");
    const realized = writable
      ? await materializePrivate({
          project: envDir,
          store,
          graph,
          generationId,
        })
      : sharedRealized;
    const toolRealization = realized.realizationDirByKey.get(tool.key);
    if (toolRealization === undefined)
      throw internal(`missing realization for ${tool.key}`);
    const toolPkgDir = packageDirIn(toolRealization, tool.name);

    const binKey = selectBin(tool, options.binName);
    const binTarget = tool.bin[binKey];
    if (binTarget === undefined)
      throw internal(`selected bin ${binKey} vanished`);
    const script = await resolveBinScript(toolPkgDir, tool, binKey, binTarget);

    const bins: Record<string, string> = {};
    for (const [name, target] of Object.entries(tool.bin)) {
      bins[name] = await resolveBinScript(toolPkgDir, tool, name, target);
    }
    for (const edge of tool.edges) {
      const dependency = byKey.get(edge.target);
      const directory = realized.packageDirByKey.get(edge.target);
      if (dependency === undefined || directory === undefined) continue;
      for (const [name, target] of Object.entries(dependency.bin)) {
        if (bins[name] === undefined)
          bins[name] = await resolveBinScript(
            directory,
            dependency,
            name,
            target,
          );
      }
    }
    const projectId = randomId("proj1_");
    const leaseId = randomId("lease1_");
    let registered = false;
    try {
      const registration = await registerGeneration({
        store,
        project: envDir,
        projectId,
        generationId,
        graph,
        realized,
        sharedRealized,
        roots: [tool.key],
        readiness: "ready",
      });
      try {
        registration.activate();
        const db = openStoreDb(store.paths.dbFile);
        try {
          const identity = currentProcessIdentity(),
            now = new Date().toISOString();
          db.prepare(
            "INSERT INTO leases VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
          ).run(
            leaseId,
            identity.pid,
            identity.startId,
            os.hostname(),
            JSON.stringify({
              generationId,
              instances: registration.instances,
              contexts: registration.contexts,
            }),
            now,
            now,
          );
          registered = true;
        } finally {
          db.close();
        }
      } finally {
        registration.close();
      }
      await installProjection(
        envDir,
        [{ name: tool.name, linkTarget: toolPkgDir }],
        { bins, generationId, projectId },
      );
      return {
        ...(await runTool(
          script,
          args,
          cwd,
          {
            ...env,
            PATH:
              path.join(envDir, "node_modules", ".bin") +
              path.delimiter +
              (env.PATH ?? ""),
          },
          options.capture === true,
        )),
        key: tool.key,
        name: tool.name,
        version: tool.version,
        reused: sharedRealized.created.length === 0,
        envDir,
      };
    } finally {
      await rmrfNoFollow(envDir);
      if (registered) {
        const db = openStoreDb(store.paths.dbFile);
        try {
          db.prepare(
            "UPDATE leases SET state='released',heartbeat_at=? WHERE lease_id=?",
          ).run(new Date().toISOString(), leaseId);
          db.prepare(
            "UPDATE roots SET state='removed' WHERE generation_id=?",
          ).run(generationId);
          db.prepare(
            "UPDATE generations SET state='abandoned' WHERE generation_id=?",
          ).run(generationId);
        } finally {
          db.close();
        }
      }
    }
  } finally {
    try {
      if (envDir !== undefined) await rmrfNoFollow(envDir);
      await txn?.finish();
    } finally {
      await barrier.release();
    }
  }
}

// ---------------------------------------------------------------------------

/** Deny-by-default script policy: any install-time script blocks the run. */
async function assertNoInstallScripts(
  packageDirByKey: Map<string, string>,
  byKey: Map<string, ResolvedOccurrence>,
): Promise<void> {
  const packages = [...packageDirByKey.entries()];
  // Bundled packages are real directories, unlike the dependency-context
  // symlinks. Inspect them too; do not walk dependency links or execute code.
  const collectBundled = async (
    directory: string,
    label: string,
  ): Promise<void> => {
    const children = await readdir(path.join(directory, "node_modules"), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const child of children) {
      if (!child.isDirectory() || child.name === ".bin") continue;
      const packagePath = path.join(directory, "node_modules", child.name);
      const members = child.name.startsWith("@")
        ? await readdir(packagePath, { withFileTypes: true })
        : [child];
      for (const member of members) {
        if (!member.isDirectory()) continue;
        const bundledPath = child.name.startsWith("@")
          ? path.join(packagePath, member.name)
          : packagePath;
        const bundledLabel = `${label} bundled ${child.name}${child.name.startsWith("@") ? "/" + member.name : ""}`;
        packages.push([bundledLabel, bundledPath]);
        await collectBundled(bundledPath, bundledLabel);
      }
    }
  };
  for (const [key, directory] of packageDirByKey)
    await collectBundled(directory, key);
  for (const [key, pkgDir] of packages) {
    const node = byKey.get(key);
    const label = node === undefined ? key : `${node.name}@${node.version}`;
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(path.join(pkgDir, "package.json"), "utf8"),
      );
    } catch (error) {
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        `tool closure package ${label} has no readable package.json`,
        {
          detail: { package: label },
          remedy: "tools must ship a readable package manifest",
          cause: error,
        },
      );
    }
    if (
      await stat(path.join(pkgDir, "binding.gyp")).then(
        () => true,
        () => false,
      )
    ) {
      throw new ZyrkError(
        "ZYRK_SCRIPT_BLOCKED",
        `tool ${label} requires an implicit node-gyp build`,
        {
          detail: { package: label },
          remedy:
            "Select a prebuilt tool; dependency builds require explicit approval and private build support.",
        },
      );
    }
    const scripts = (raw as { scripts?: unknown }).scripts;
    const table: Record<string, unknown> =
      typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
        ? (scripts as Record<string, unknown>)
        : {};
    for (const stage of ["preinstall", "install", "postinstall"]) {
      const script = table[stage];
      if (typeof script === "string" && script.trim() !== "") {
        throw new ZyrkError(
          "ZYRK_SCRIPT_BLOCKED",
          `tool ${label} declares install-time script "${stage}"`,
          {
            detail: { package: label, script: stage },
            remedy:
              "dependency lifecycle scripts are denied by default; remove the scripted dependency or approve it explicitly once script review is available",
          },
        );
      }
    }
  }
}

function selectBin(
  tool: ResolvedOccurrence,
  binName: string | undefined,
): string {
  const label = `${tool.name}@${tool.version}`;
  if (binName !== undefined) {
    if (tool.bin[binName] === undefined) {
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        `tool ${label} has no bin entry "${binName}"`,
        {
          detail: {
            package: label,
            requested: binName,
            available: Object.keys(tool.bin),
          },
          remedy: "pick one of the available bin names",
        },
      );
    }
    return binName;
  }
  const names = Object.keys(tool.bin);
  if (names.length === 0) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `tool ${label} declares no executable bin entry`,
      {
        detail: { package: label },
        remedy:
          "tools run through their declared bin entry; pick a package that declares one",
      },
    );
  }
  const only = names[0];
  if (names.length === 1 && only !== undefined) return only;
  const short = tool.name.startsWith("@")
    ? (tool.name.split("/")[1] ?? tool.name)
    : tool.name;
  if (tool.bin[short] !== undefined) return short;
  throw new ZyrkError(
    "ZYRK_RESOLUTION_FAILED",
    `tool ${label} declares several bins (${names.join(", ")}); select one explicitly`,
    {
      detail: { package: label, available: names },
      remedy: "rerun with an explicit bin name",
    },
  );
}

async function resolveBinScript(
  pkgDir: string,
  tool: ResolvedOccurrence,
  binKey: string,
  target: string,
): Promise<string> {
  const label = `${tool.name}@${tool.version}`;
  const script = path.resolve(pkgDir, target);
  const relative = path.relative(pkgDir, script);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `tool ${label} bin "${binKey}" escapes the package`,
      {
        detail: { package: label, bin: binKey },
        remedy: "bin targets must stay inside the package directory",
      },
    );
  }
  let info;
  try {
    info = await lstat(script);
  } catch (error) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `tool ${label} bin "${binKey}" is missing from the package`,
      {
        detail: { package: label, bin: binKey },
        remedy:
          "the registry archive does not match its manifest; report the package",
        cause: error,
      },
    );
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `tool ${label} bin "${binKey}" is not a file`,
      {
        detail: { package: label, bin: binKey },
        remedy: "bin entries must point at executable files",
      },
    );
  }
  const actual = await realpath(script);
  const physicalRelative = path.relative(await realpath(pkgDir), actual);
  if (
    physicalRelative === "" ||
    physicalRelative === ".." ||
    physicalRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(physicalRelative)
  ) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `tool ${label} bin "${binKey}" escapes the package through a link`,
      { remedy: "Bin targets must resolve inside their package." },
    );
  }
  if (!(await stat(actual)).isFile())
    throw internal("tool bin does not resolve to a regular file");
  return actual;
}

async function runTool(
  script: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  capture: boolean,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const file = await stat(script);
  // Node sources without a shebang remain supported. Executable shell/native
  // entries go directly through exec; no shell command string is constructed.
  const handle = await open(script, "r");
  const prefix = Buffer.alloc(256);
  let count: number;
  try {
    count = (await handle.read(prefix, 0, prefix.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const firstLine =
    prefix.subarray(0, count).toString("utf8").split("\n")[0] ?? "";
  const node = firstLine.startsWith("#!")
    ? /^#!.*\bnode(?:\s|$)/.test(firstLine)
    : /\.(?:[cm]?js|ts)$/.test(script);
  if (!node && (file.mode & 0o111) === 0)
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      "Tool bin is not executable.",
      {
        remedy:
          "Select a tool shipping an executable shell/native bin or a Node entry point.",
      },
    );
  try {
    return await superviseChild(
      node ? process.execPath : script,
      node ? [script, ...args] : args,
      { cwd, env, capture },
    );
  } catch (cause) {
    throw new ZyrkError("ZYRK_INTERNAL", "Failed to launch the tool process.", {
      cause,
      remedy: "Verify that the tool supports this OS and executable format.",
    });
  }
}

function internal(message: string): ZyrkError {
  return new ZyrkError("ZYRK_INTERNAL", message);
}
