import {
  selectPlatformGraph,
  selectWorkspacePlatform,
} from "../install/platform.ts";
import {
  discoverWorkspaces,
  findWorkspaceRoot,
  planWorkspaceDependencies,
  selectWorkspaceImporters,
  workspaceScriptOrder,
} from "../install/workspaces.ts";
import { readWorkspaceLock } from "../install/workspace-lock.ts";
/** Project inspection and explicit execution (SPEC 12.2, 18.3.1, D-1). */
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
import { superviseChild, currentProcessIdentity } from "../util/proc.ts";
import { randomId } from "../util/ids.ts";
import { canonicalJson } from "../util/json.ts";
import { sha512Hex } from "../util/hash.ts";
import { CLI_VERSION } from "../version.ts";
import { renderCommandOutput } from "../cli/terminal.ts";

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
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  json?: boolean;
  workspaceLockHeld?: boolean;
  initialCwd?: string;
};
type State = {
  generationId: string;
  projectId: string;
  graphDigest: string;
  lockDigest: string;
  readiness: string;
  linker?: "private" | "shared";
  omitDev?: boolean;
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
    (raw.linker !== undefined &&
      raw.linker !== "private" &&
      raw.linker !== "shared") ||
    (raw.omitDev !== undefined && typeof raw.omitDev !== "boolean") ||
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
async function load(project: string): Promise<{
  state: State;
  extension: Pick<ZyrkLockExtension, "manifest" | "roots"> & {
    nodes: Record<
      string,
      Pick<
        ZyrkLockExtension["nodes"][string],
        "name" | "version" | "source" | "edges" | "peers"
      >
    >;
  };
}> {
  const state = validateState(
    await json(path.join(project, "node_modules/.zyrk/install-state.json")),
  );
  const workspaceRoot = await findWorkspaceRoot(project);
  if (workspaceRoot) {
    const workspace = await discoverWorkspaces(workspaceRoot);
    const locked = await readWorkspaceLock(workspaceRoot, workspace);
    if (
      !locked ||
      locked.doc.zyrk?.manifest !== workspace.manifestFingerprint ||
      state.lockDigest !== sha512Hex(canonicalJson(locked.doc))
    )
      throw fail(
        "ZYRK_LOCK_MISMATCH",
        "The workspace manifests, authoritative lock and installed generation disagree.",
      );
    const importer = workspace.importers.find(
      (item) => item.directory === project,
    );
    const activeGraph = selectWorkspacePlatform(
      locked.graph,
      undefined,
      state.omitDev,
    );
    const own = activeGraph.nodes.find(
      (node) => node.kind === "local" && node.importer === importer?.id,
    );
    if (!own)
      throw fail(
        "ZYRK_LOCK_MISMATCH",
        "The selected workspace importer is absent from the authoritative graph.",
      );
    return {
      state,
      extension: {
        manifest: manifestFingerprint(importer!.manifest),
        roots: {
          ".": Object.fromEntries(
            own.edges.map((edge) => [edge.name, edge.target]),
          ),
        },
        nodes: Object.fromEntries(
          activeGraph.nodes.map((node) => [
            node.key,
            {
              name: node.name,
              version: node.version,
              source:
                node.kind === "registry"
                  ? node.sourceId
                  : `workspace:${node.importer}`,
              edges: Object.fromEntries(
                node.edges.map((edge) => [edge.name, edge.target]),
              ),
              peers: node.peers,
            },
          ]),
        ),
      },
    };
  }
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
  const graph = selectPlatformGraph(
    {
      ...lockedGraph(doc),
      roots: lockedGraph(doc).roots.filter((root) =>
        state.direct.some((entry) => entry.name === root.name),
      ),
    },
    new Set(
      Object.keys(
        object(doc.packages?.[""]?.optionalDependencies)
          ? doc.packages[""]!.optionalDependencies
          : {},
      ),
    ),
  );
  return {
    state,
    extension: {
      ...doc.zyrk,
      roots: {
        ".": Object.fromEntries(
          graph.roots.map((root) => [root.name, root.target]),
        ),
      },
      nodes: Object.fromEntries(
        graph.nodes.map((node) => [
          node.key,
          {
            ...doc.zyrk!.nodes[node.key]!,
            edges: Object.fromEntries(
              node.edges.map((edge) => [edge.name, edge.target]),
            ),
            peers: Object.fromEntries(
              node.peerBindings.map((peer) => [peer.name, peer.target]),
            ),
          },
        ]),
      ),
    },
  };
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
      : renderCommandOutput(
          options.command,
          options.command === "doctor" && options.stdout.isTTY
            ? JSON.stringify(result)
            : `${human}\n`,
          {
            ...(options.stdout.isTTY === undefined
              ? {}
              : { isTTY: options.stdout.isTTY }),
            color:
              options.env.NO_COLOR === undefined && options.env.TERM !== "dumb",
          },
        ),
  );
}

export async function runProjectCommand(
  options: ProjectCommandOptions,
): Promise<number> {
  const selectors: string[] = [];
  let recursive = false,
    consumed = 0;
  while (consumed < options.args.length) {
    const arg = options.args[consumed]!;
    if (arg === "--workspace" || arg === "-w") {
      const selector = options.args[consumed + 1];
      if (!selector || selector.startsWith("-"))
        throw fail(
          "ZYRK_USAGE",
          "Select an exact workspace name or path after --workspace.",
        );
      selectors.push(selector);
      consumed += 2;
    } else if (arg.startsWith("--workspace=")) {
      selectors.push(arg.slice(12));
      consumed++;
    } else if (arg === "--recursive" || arg === "-r") {
      recursive = true;
      consumed++;
    } else break;
  }
  if (consumed) {
    const root = await findWorkspaceRoot(options.cwd);
    if (!root || (recursive && selectors.length))
      throw fail(
        "ZYRK_USAGE",
        "Use exact --workspace selections or --recursive inside a workspace.",
      );
    const workspace = await discoverWorkspaces(root);
    let selected = recursive
      ? workspace.importers.filter((item) => item.id !== ".")
      : selectWorkspaceImporters(workspace, selectors);
    if (recursive) {
      const order = workspaceScriptOrder(planWorkspaceDependencies(workspace));
      selected = order.flatMap((id) =>
        selected.filter((item) => item.id === id),
      );
    }
    if (!selected.length)
      throw fail("ZYRK_USAGE", "No workspace importers were selected.");
    const control = await lstat(path.join(root, PROJECT_STATE_DIR)).catch(
      () => null,
    );
    if (!control?.isDirectory() || control.isSymbolicLink())
      throw fail(
        "ZYRK_STORE_CORRUPT",
        "Install the workspace before executing or inspecting its importers.",
      );
    const outer = await acquireLock(
      path.join(root, PROJECT_STATE_DIR, "project.lock"),
      { name: "workspace operation" },
    );
    try {
      const results: unknown[] = [];
      for (const member of selected) {
        let captured = "";
        const inspecting =
          options.command !== "run" && options.command !== "exec";
        const code = await runProjectCommand({
          ...options,
          cwd: member.directory,
          initialCwd: options.initialCwd ?? options.cwd,
          args: options.args.slice(consumed),
          workspaceLockHeld: true,
          ...(options.json && inspecting
            ? {
                stdout: {
                  write: (value: string) => {
                    captured += value;
                  },
                },
              }
            : {}),
        });
        if (options.json && inspecting)
          results.push({
            workspace: member.id,
            ...(JSON.parse(captured) as Obj),
          });
        if (code !== 0) return code;
      }
      if (results.length)
        options.stdout.write(
          JSON.stringify({
            schemaVersion: 1,
            command: options.command,
            workspaces: results,
          }) + "\n",
        );
      return 0;
    } finally {
      await outer.release();
    }
  }
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
  const coordinationRoot = (await findWorkspaceRoot(project)) ?? project;
  const control = await lstat(
    path.join(coordinationRoot, PROJECT_STATE_DIR),
  ).catch(() => null);
  if (control && (!control.isDirectory() || control.isSymbolicLink()))
    throw fail(
      "ZYRK_STORE_CORRUPT",
      "Project control directory is not a real directory.",
    );
  const held = options.workspaceLockHeld
    ? undefined
    : await acquireLock(
        path.join(coordinationRoot, PROJECT_STATE_DIR, "project.lock"),
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
        realization: state.linker ?? "shared",
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
      await authorizeScript(options.env, selected);
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
      INIT_CWD: options.initialCwd ?? options.cwd,
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
    await held?.release();
  }
}
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function authorizeScript(
  env: NodeJS.ProcessEnv,
  selected: string,
): Promise<void> {
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
    Object.keys(raw).some(
      (key) => key !== "scripts" && /script|policy|security/i.test(key),
    )
  )
    throw fail(
      "ZYRK_POLICY_DENIED",
      "Configured user script policy cannot be enforced by this runner; project script execution is denied.",
    );
  const policy = raw.scripts;
  if (policy === undefined) return;
  if (
    !object(policy) ||
    Object.keys(policy).some(
      (key) => !["default", "allow", "deny"].includes(key),
    ) ||
    (policy.default !== undefined && policy.default !== "deny") ||
    [policy.allow, policy.deny].some(
      (value) =>
        value !== undefined &&
        (!Array.isArray(value) ||
          value.some((rule) => typeof rule !== "string")),
    )
  )
    throw fail(
      "ZYRK_POLICY_DENIED",
      "Configured user script policy is malformed or unsupported.",
    );
  if (
    Array.isArray(policy.deny) &&
    policy.deny.some(
      (rule) =>
        rule === "*" || rule === selected || rule === `project:${selected}`,
    )
  )
    throw fail(
      "ZYRK_POLICY_DENIED",
      "The explicitly selected project script is denied by mandatory user policy.",
    );
  // The named run command is explicit permission; default deny prevents implicit hooks.
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
  let db: ReturnType<typeof openStoreDb> | undefined;
  const lease = "lease1_" + randomId("", 16);
  let registered = false;
  try {
    db = openStoreDb(store.paths.dbFile);
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
    registered = true;
    // Keep the project -> store lock order and conservatively retain the store
    // barrier until supervised children have stopped and the lease is released.
    try {
      return (
        await superviseChild(command, args, {
          cwd,
          env,
          stdout: options.stdout,
          stderr: options.stderr,
          onSpawn(pid, startId) {
            db!
              .prepare(
                "UPDATE leases SET holder_pid=?, holder_start_id=? WHERE lease_id=?",
              )
              .run(pid, startId, lease);
          },
        })
      ).exitCode;
    } catch (error) {
      throw new ZyrkError(
        "ZYRK_BUILD_FAILED",
        "Cannot launch the selected project command.",
        {
          cause: error,
          remedy:
            "Verify the project script or installed executable supports this OS and retry.",
        },
      );
    }
  } finally {
    try {
      if (registered)
        db!
          .prepare(
            "UPDATE leases SET state='released', heartbeat_at=? WHERE lease_id=?",
          )
          .run(new Date().toISOString(), lease);
    } finally {
      db?.close();
      await barrier.release();
    }
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
