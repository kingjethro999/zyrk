/** Project inspection and explicit execution (SPEC 12.2, 18.3.1, D-1). */
import { spawn } from "node:child_process";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { hostname } from "node:os";
import {
  findProjectBoundary,
  resolveConfigFile,
  resolveStoreRoot,
} from "../config/paths.ts";
import { ZyrkError, type ErrorCode } from "../errors.ts";
import { lockedGraph, packageName } from "../install/lock.ts";
import { validateLockDoc } from "../lockfile/read.ts";
import {
  manifestFingerprint,
  type ManifestDeclaration,
} from "../lockfile/fingerprints.ts";
import { type ZyrkLockExtension } from "../lockfile/types.ts";
import { PROJECT_STATE_DIR } from "../project/projection.ts";
import { openStoreDb } from "../store/db.ts";
import { Store } from "../store/layout.ts";
import { acquireLock } from "../util/locks.ts";
import { closeCode, currentProcessIdentity } from "../util/proc.ts";
import { randomId } from "../util/ids.ts";
import { canonicalJson } from "../util/json.ts";
import { sha512Hex } from "../util/hash.ts";
import { CLI_VERSION } from "../version.ts";

type Obj = Record<string, unknown>;
function object(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(code: ErrorCode, message: string): ZyrkError {
  return new ZyrkError(code, message, {
    remedy:
      "Review the project manifest, run zyrk install to restore its selected graph, and retry.",
  });
}
async function json(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw fail(
      "ZYRK_MANIFEST_INVALID",
      "Cannot read project metadata as JSON.",
    );
  }
}
export type ProjectCommandOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  json?: boolean;
};
type State = {
  generationId: string;
  projectId: string;
  graphDigest: string;
  lockDigest: string;
  readiness: string;
  direct: { name: string; target: string }[];
};
function validateState(raw: unknown): State {
  if (
    !object(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.generationId !== "string" ||
    !/^gen1_[\w-]+$/.test(raw.generationId) ||
    typeof raw.projectId !== "string" ||
    typeof raw.graphDigest !== "string" ||
    typeof raw.lockDigest !== "string" ||
    typeof raw.readiness !== "string" ||
    !Array.isArray(raw.direct) ||
    raw.direct.some(
      (e) =>
        !object(e) ||
        typeof e.name !== "string" ||
        !packageName(e.name) ||
        typeof e.target !== "string",
    )
  )
    throw fail(
      "ZYRK_STORE_CORRUPT",
      "Project install state is missing or malformed.",
    );
  return raw as unknown as State;
}
async function load(
  project: string,
): Promise<{ state: State; extension: ZyrkLockExtension }> {
  const state = validateState(
    await json(path.join(project, "node_modules/.zyrk/install-state.json")),
  );
  let doc;
  try {
    doc = validateLockDoc(
      await json(path.join(project, "package-lock.json")),
      "project package-lock.json",
    );
    lockedGraph(doc);
  } catch {
    throw fail(
      "ZYRK_LOCK_MISMATCH",
      "Cannot inspect the installed graph: package-lock.json has no compatible zyrk extension.",
    );
  }
  if (
    sha512Hex(canonicalJson(doc)) !== state.lockDigest ||
    doc.zyrk === undefined
  )
    throw fail(
      "ZYRK_LOCK_MISMATCH",
      "The installed generation and package-lock.json disagree.",
    );
  return { state, extension: doc.zyrk };
}
function emit(
  options: ProjectCommandOptions,
  result: unknown,
  human: string,
): void {
  options.stdout.write(
    options.json
      ? JSON.stringify({
          schemaVersion: 1,
          command: options.command,
          ...(result as Obj),
        }) + "\n"
      : human + "\n",
  );
}

export async function runProjectCommand(
  options: ProjectCommandOptions,
): Promise<number> {
  const boundary = await findProjectBoundary(options.cwd);
  if (!boundary)
    throw fail("ZYRK_MANIFEST_INVALID", "Cannot find a project package.json.");
  const project = await realpath(boundary);
  const manifest = await json(path.join(project, "package.json"));
  if (!object(manifest))
    throw fail(
      "ZYRK_MANIFEST_INVALID",
      "Project package.json must be an object.",
    );
  const executing = options.command === "run" || options.command === "exec";
  if (
    (!executing && options.command !== "why" && options.args.length !== 0) ||
    (options.command === "why" &&
      (options.args.length !== 1 || !packageName(options.args[0] ?? "")))
  )
    throw fail("ZYRK_USAGE", "Invalid project command arguments.");
  if (executing && !options.args[0])
    throw fail(
      "ZYRK_USAGE",
      "Select a project script or installed executable.",
    );
  // Never follow a replaced control directory when acquiring the project lock.
  const control = await lstat(path.join(project, PROJECT_STATE_DIR)).catch(
    () => null,
  );
  if (control && (!control.isDirectory() || control.isSymbolicLink()))
    throw fail(
      "ZYRK_STORE_CORRUPT",
      "Project control directory is not a real directory.",
    );
  const held = await acquireLock(
    path.join(project, PROJECT_STATE_DIR, "project.lock"),
    { name: "project execution or inspection" },
  );
  try {
    if (options.command === "doctor")
      return await doctor(options, project, manifest);
    const { state, extension } = await load(project);
    if (options.command === "list" || options.command === "why") {
      const activeKeys = new Set<string>();
      const visit = (key: string): void => {
        if (activeKeys.has(key)) return;
        activeKeys.add(key);
        for (const target of Object.values(extension.nodes[key]?.edges ?? {}))
          visit(target);
      };
      for (const entry of state.direct) {
        const key = extension.roots["."]?.[entry.name];
        if (key !== undefined) visit(key);
      }
      const installed = Object.entries(extension.nodes).filter(([key]) =>
        activeKeys.has(key),
      );
      const details = await retentionDetails(options.env, state);
      const selected =
        options.command === "why"
          ? installed.filter(([, n]) => n.name === options.args[0])
          : installed;
      const nodes = selected.map(([key, n]) => ({
        key,
        name: n.name,
        version: n.version,
        source: n.source,
        peers: n.peers,
        contexts: details
          .filter((d) => d.source === n.source)
          .map((d) => d.context),
        retainingProjects: [
          ...new Set(
            details
              .filter((d) => d.source === n.source)
              .flatMap((d) => d.projects),
          ),
        ],
        dependencies: n.edges,
        direct: Object.entries(extension.roots["."] ?? {})
          .filter(([, target]) => target === key)
          .map(([name]) => name),
        requiredBy: installed.flatMap(([parent, node]) =>
          Object.entries(node.edges)
            .filter(([, target]) => target === key)
            .map(([name]) => ({ parent, name })),
        ),
        realization: "shared",
      }));
      if (options.command === "why" && !nodes.length)
        throw fail(
          "ZYRK_RESOLUTION_FAILED",
          "The requested package is absent from the installed graph.",
        );
      emit(
        options,
        {
          generationId: state.generationId,
          graphDigest: state.graphDigest,
          readiness: state.readiness,
          nodes,
        },
        nodes
          .map(
            (n) =>
              `${n.name}@${n.version}${n.direct.length ? " (direct: " + n.direct.join(", ") + ")" : ""}${n.requiredBy.length ? " <- " + n.requiredBy.map((p) => extension.nodes[p.parent]?.name).join(", ") : ""}`,
          )
          .join("\n") || "No installed dependencies.",
      );
      return 0;
    }
    if (!executing) throw fail("ZYRK_USAGE", "Unknown project command.");
    if (state.readiness !== "ready")
      throw fail(
        "ZYRK_SCRIPT_BLOCKED",
        "Cannot execute an intentionally unbuilt or unready dependency generation.",
      );
    let command: string, args: string[];
    const selected = options.args[0]!;
    if (options.command === "run") {
      await authorizeScript(options.env);
      const scripts = manifest.scripts;
      if (
        !object(scripts) ||
        !Object.hasOwn(scripts, selected) ||
        typeof scripts[selected] !== "string"
      )
        throw fail(
          "ZYRK_USAGE",
          "The selected project script is not declared.",
        );
      const forwarded = options.args.slice(options.args[1] === "--" ? 2 : 1);
      command = "/bin/sh";
      args = [
        "-c",
        scripts[selected] +
          (forwarded.length ? " " + forwarded.map(quote).join(" ") : ""),
      ];
    } else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(selected))
        throw fail(
          "ZYRK_USAGE",
          "Select an installed executable by its local bin name.",
        );
      command = path.join(project, "node_modules/.bin", selected);
      try {
        await access(command, constants.X_OK);
        if (!(await lstat(await realpath(command))).isFile()) throw new Error();
      } catch {
        throw fail(
          "ZYRK_RESOLUTION_FAILED",
          "The selected executable is not installed locally; exec never fetches packages.",
        );
      }
      args = options.args.slice(1);
    }
    const env = {
      ...options.env,
      PATH:
        path.join(project, "node_modules/.bin") +
        path.delimiter +
        (options.env.PATH ?? ""),
      INIT_CWD: options.cwd,
      npm_package_json: path.join(project, "package.json"),
      npm_execpath: path.resolve(import.meta.dirname, "../../bin/zyrk.js"),
      npm_config_user_agent: `zyrk/${CLI_VERSION} node/${process.version} ${process.platform} ${process.arch}`,
    };
    if (options.command === "run")
      Object.assign(env, {
        npm_lifecycle_event: selected,
        npm_lifecycle_script: (manifest.scripts as Obj)[selected],
      });
    return await leasedChild(options, state, command, args, project, env);
  } finally {
    await held.release();
  }
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function authorizeScript(env: NodeJS.ProcessEnv): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolveConfigFile({ env }), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw fail(
      "ZYRK_POLICY_DENIED",
      "Cannot read user execution policy; project script execution is denied.",
    );
  }
  // No permissive interpretation of security settings not implemented by this runner.
  if (
    !object(raw) ||
    Object.keys(raw).some((key) => /script|policy|security/i.test(key))
  )
    throw fail(
      "ZYRK_POLICY_DENIED",
      "Configured user script policy cannot be enforced by this runner; project script execution is denied.",
    );
}
async function leasedChild(
  options: ProjectCommandOptions,
  state: State,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let store: Store;
  try {
    store = await Store.open({
      root: resolveStoreRoot({ env: options.env }).root,
    });
    store.requireInitialized();
  } catch {
    throw fail(
      "ZYRK_STORE_UNSAFE",
      "Cannot lease the installed graph in the selected user store.",
    );
  }
  const barrier = await acquireLock(
    path.join(store.paths.locksDir, "liveness.lock"),
    { name: "generation lease registration" },
  );
  const db = openStoreDb(store.paths.dbFile);
  const lease = "lease1_" + randomId("", 16);
  try {
    const generation = db
      .prepare(
        "SELECT generation_id FROM generations WHERE generation_id = ? AND project_id = ? AND graph_digest = ? AND state = 'active'",
      )
      .get(state.generationId, state.projectId, state.graphDigest);
    if (!generation)
      throw fail(
        "ZYRK_STORE_CORRUPT",
        "Cannot lease the installed generation: its store registration is absent or inconsistent.",
      );
    const instances = db
      .prepare(
        "SELECT instance_id FROM generation_instances WHERE generation_id = ? ORDER BY instance_id",
      )
      .all(state.generationId)
      .map((row) => row.instance_id);
    const identity = currentProcessIdentity(),
      now = new Date().toISOString();
    db.prepare("INSERT INTO leases VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(
      lease,
      identity.pid,
      identity.startId,
      hostname(),
      JSON.stringify({
        generationId: state.generationId,
        graphDigest: state.graphDigest,
        instances,
      }),
      now,
      now,
    );
  } catch (error) {
    db.close();
    throw error;
  } finally {
    await barrier.release();
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["inherit", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      // Once spawned, the child owns liveness even if the wrapper is killed.
      // A null start discriminator intentionally retains a recycled PID conservatively.
      if (child.pid !== undefined)
        db.prepare(
          "UPDATE leases SET holder_pid=?, holder_start_id=NULL WHERE lease_id=?",
        ).run(child.pid, lease);
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const listeners = signals.map((signal) => {
        const listener = () => {
          try {
            if (child.pid)
              process.kill(
                process.platform === "win32" ? child.pid : -child.pid,
                signal,
              );
          } catch {
            /* A finished child needs no forwarding. */
          }
        };
        process.on(signal, listener);
        return [signal, listener] as const;
      });
      child.stdout?.on("data", (chunk: Buffer) =>
        options.stdout.write(chunk.toString()),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        options.stderr.write(chunk.toString()),
      );
      child.once("error", () => {
        reject(
          fail(
            "ZYRK_BUILD_FAILED",
            "Cannot launch the selected project command.",
          ),
        );
      });
      child.once("close", (code, signal) => {
        for (const [sig, listener] of listeners) process.off(sig, listener);
        resolve(closeCode(code, signal));
      });
    });
  } finally {
    db.prepare(
      "UPDATE leases SET state='released', heartbeat_at=? WHERE lease_id=?",
    ).run(new Date().toISOString(), lease);
    db.close();
  }
}
async function doctor(
  options: ProjectCommandOptions,
  project: string,
  manifest: Obj,
): Promise<number> {
  const diagnostics: {
    code: string;
    severity: "error" | "warning";
    message: string;
  }[] = [];
  const add = (
    code: string,
    message: string,
    severity: "error" | "warning" = "error",
  ) => diagnostics.push({ code, severity, message });
  try {
    const { state, extension } = await load(project);
    if (
      manifestFingerprint(manifest as ManifestDeclaration) !==
      extension.manifest
    )
      add(
        "ZYRK_LOCK_MISMATCH",
        "Dependency declarations differ from the installed lock.",
      );
    if (state.readiness !== "ready")
      add(
        "ZYRK_SCRIPT_BLOCKED",
        "Installed dependencies are intentionally unbuilt or unready.",
      );
    const expected = new Set(state.direct.map((entry) => entry.name));
    for (const item of await readdir(path.join(project, "node_modules"))) {
      if (item.startsWith(".")) continue;
      const names = item.startsWith("@")
        ? (await readdir(path.join(project, "node_modules", item))).map(
            (name) => `${item}/${name}`,
          )
        : [item];
      for (const name of names)
        if (!expected.has(name))
          add(
            "ZYRK_STORE_CORRUPT",
            "Unexpected package entry exists outside the installed projection.",
          );
    }
    for (const entry of state.direct) {
      try {
        const link = path.join(project, "node_modules", entry.name);
        if (
          !(await lstat(link)).isSymbolicLink() ||
          (await realpath(link)) !== (await realpath(entry.target))
        )
          throw new Error();
      } catch {
        add(
          "ZYRK_STORE_CORRUPT",
          `Installed dependency link for ${entry.name} is missing or changed.`,
        );
      }
    }
  } catch (error) {
    add(
      error instanceof ZyrkError ? error.code : "ZYRK_STORE_CORRUPT",
      "Project install state or its lock is missing, invalid, or inconsistent.",
    );
  }
  try {
    const store = await Store.open({
      root: resolveStoreRoot({ env: options.env }).root,
    });
    if (!store.initialized)
      add("ZYRK_STORE_UNSAFE", "The selected user store is not initialized.");
  } catch {
    add(
      "ZYRK_STORE_UNSAFE",
      "The selected user store failed ownership, format, or filesystem safety checks.",
    );
  }
  if (options.env.NODE_PATH)
    add(
      "ZYRK_POLICY_DENIED",
      "NODE_PATH enables ambient package lookup outside the selected graph.",
      "warning",
    );
  if (
    /--preserve-symlinks(?:-main)?(?:\s|=|$)/.test(
      options.env.NODE_OPTIONS ?? "",
    )
  )
    add(
      "ZYRK_POLICY_DENIED",
      "Symlink preservation in NODE_OPTIONS can change dependency and singleton resolution.",
      "warning",
    );
  const ok = !diagnostics.some((d) => d.severity === "error");
  emit(
    options,
    { ok, diagnostics },
    diagnostics.length
      ? diagnostics
          .map((d) => `${d.severity}: ${d.code}: ${d.message}`)
          .join("\n")
      : "Project lock, direct dependency links, readiness, and store safety checks passed.",
  );
  return ok ? 0 : 1;
}

async function retentionDetails(
  env: NodeJS.ProcessEnv,
  state: State,
): Promise<{ source: string; context: string; projects: string[] }[]> {
  try {
    const store = await Store.open({ root: resolveStoreRoot({ env }).root });
    if (!store.initialized) return [];
    const db = openStoreDb(store.paths.dbFile);
    try {
      const rows = db
        .prepare(
          `SELECT r.source_id, gi.context_id FROM generation_instances gi JOIN realizations r ON r.context_id=gi.context_id WHERE gi.generation_id=?`,
        )
        .all(state.generationId);
      return rows.map((row) => ({
        source: String(row.source_id),
        context: String(row.context_id),
        projects: db
          .prepare(
            `SELECT DISTINCT g.project_id FROM generations g JOIN generation_instances gi ON gi.generation_id=g.generation_id JOIN roots root ON root.generation_id=g.generation_id WHERE gi.context_id=? AND root.state <> 'removed' ORDER BY g.project_id`,
          )
          .all(row.context_id!)
          .map((p) => String(p.project_id)),
      }));
    } finally {
      db.close();
    }
  } catch {
    throw fail(
      "ZYRK_STORE_CORRUPT",
      "Cannot inspect the installed generation retention metadata.",
    );
  }
}
