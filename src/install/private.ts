/** Source-bound build review and whole-project private generations (§11–12). */
import {
  readFile,
  mkdir,
  copyFile,
  chmod,
  symlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { resolveConfigFile } from "../config/paths.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { objectPathFor, verifyObjectPayload } from "../store/objects.ts";
import { contextIdFor, graphHash, type GraphDoc } from "../store/graph.ts";
import type { RealizeResult } from "../store/realize.ts";
import type { ResolvedOccurrence } from "../resolve/resolver.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { isErrno, pathExists, writeFileAtomic } from "../util/fsx.ts";
import { superviseChild } from "../util/proc.ts";
import { redactSecrets } from "../log.ts";
import { acquireLock } from "../util/locks.ts";

export type BuildCandidate = {
  key: string;
  name: string;
  version: string;
  sourceId: string;
  stages: Array<{ name: string; command: string }>;
};
export type BuildReview = BuildCandidate & {
  decision: "approved" | "denied" | "pending";
  policyScope:
    | "user-deny"
    | "project-deny"
    | "workspace-deny"
    | "project-policy"
    | "workspace-policy"
    | "local-session"
    | "none";
};
export const WORKSPACE_POLICY_FILE = "zyrk-workspace.json";
type PortableBuildApproval = {
  name: string;
  version: string;
  sourceId: string;
};
type PortableBuildPolicy = {
  approvedBuilds: PortableBuildApproval[];
  deniedBuilds: string[];
};
function fail(message: string): never {
  throw new ZyrkError("ZYRK_SCRIPT_BLOCKED", message, {
    remedy:
      "Review the exact candidate with zyrk approve-builds, then explicitly approve its package names. Mandatory denials cannot be overridden.",
  });
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
export async function candidates(
  nodes: readonly ResolvedOccurrence[],
  dirs: ReadonlyMap<string, string>,
): Promise<BuildCandidate[]> {
  const builds: BuildCandidate[] = [];
  const seenDirs = new Set<string>();
  for (const node of nodes) {
    const directory = dirs.get(node.key);
    if (!directory)
      fail("A selected package has no lifecycle review directory.");
    const physical = await realpath(directory);
    if (seenDirs.has(physical)) continue;
    seenDirs.add(physical);
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readFile(path.join(dirs.get(node.key)!, "package.json"), "utf8"),
      );
    } catch {
      fail("A selected package has no readable manifest for lifecycle review.");
    }
    if (!object(raw) || raw.name !== node.name || raw.version !== node.version)
      fail("A selected package archive disagrees with its source identity.");
    const scripts = object(raw.scripts) ? raw.scripts : {};
    const stages: Array<{ name: string; command: string }> = [];
    for (const name of ["preinstall", "install", "postinstall"])
      if (typeof scripts[name] === "string" && scripts[name].trim())
        stages.push({ name, command: scripts[name] });
    if (
      !stages.some((s) => s.name === "install") &&
      (await pathExists(path.join(dirs.get(node.key)!, "binding.gyp")))
    )
      stages.splice(
        stages.findIndex((s) => s.name === "postinstall") < 0
          ? stages.length
          : stages.findIndex((s) => s.name === "postinstall"),
        0,
        { name: "install", command: "node-gyp rebuild" },
      );
    if (stages.length)
      builds.push({
        key: node.key,
        name: node.name,
        version: node.version,
        sourceId: node.sourceId,
        stages,
      });
  }
  return builds;
}
function denied(table: unknown, build: BuildCandidate): boolean {
  if (table === undefined) return false;
  if (
    !object(table) ||
    Object.keys(table).some((k) => !["default", "allow", "deny"].includes(k)) ||
    (table.default !== undefined && table.default !== "deny") ||
    [table.allow, table.deny].some(
      (v) =>
        v !== undefined &&
        (!Array.isArray(v) || v.some((x) => typeof x !== "string")),
    )
  )
    fail("Unsupported script policy cannot be enforced safely.");
  return (
    Array.isArray(table.deny) &&
    table.deny.some(
      (rule) =>
        rule === "*" ||
        rule === build.name ||
        rule === `${build.name}@${build.version}` ||
        rule === build.sourceId,
    )
  );
}
export function candidateDigest(
  graph: GraphDoc,
  builds: readonly BuildCandidate[],
  policy: unknown,
  patches: string,
): string {
  return sha512Hex(
    canonicalJson({
      graph: graphHash(graph),
      builds,
      policy: policy ?? null,
      patches,
    }),
  );
}
export async function approveCandidate(options: {
  project: string;
  digest: string;
  builds: readonly BuildCandidate[];
  selected: readonly string[];
  env?: NodeJS.ProcessEnv;
  policy?: unknown;
  portable?: boolean;
}): Promise<void> {
  const user = await readUserPolicy(options.env ?? process.env);
  const portablePolicy = await readPortableApprovals(options.project);
  const selected = new Set(options.selected);
  const all = selected.has("*");
  for (const name of selected)
    if (
      name !== "*" &&
      !options.builds.some((b) => b.name === name || b.sourceId === name)
    )
      fail("An approval selector does not match a reviewed build candidate.");
  const selectedBuilds = options.builds.filter(
    (build) => all || selected.has(build.name) || selected.has(build.sourceId),
  );
  const deniedSelections = selectedBuilds.filter(
    (build) =>
      denied(user.scripts, build) ||
      denied(options.policy, build) ||
      portablePolicy.deniedBuilds.includes(build.sourceId),
  );
  for (const build of deniedSelections)
    fail(`Build of ${build.name}@${build.version} is denied by policy.`);
  await writeFileAtomic(
    path.join(options.project, ".zyrk-local", "approvals.json"),
    JSON.stringify({
      schemaVersion: 1,
      candidate: options.digest,
      sources: selectedBuilds.map((build) => build.sourceId).sort(),
    }),
    { mode: 0o600 },
  );
  if (options.portable) {
    await writePortableApprovals(options.project, selectedBuilds);
  }
}

async function readPortableApprovals(
  project: string,
): Promise<PortableBuildPolicy> {
  const file = path.join(project, WORKSPACE_POLICY_FILE);
  let raw: unknown;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail("The workspace build-approval file must be a regular file.");
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (cause instanceof ZyrkError) throw cause;
    if (isErrno(cause, "ENOENT"))
      return { approvedBuilds: [], deniedBuilds: [] };
    fail("The workspace build-approval file is unreadable or malformed.");
  }
  if (
    !object(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.approvedBuilds) ||
    (raw.deniedBuilds !== undefined &&
      (!Array.isArray(raw.deniedBuilds) ||
        raw.deniedBuilds.some(
          (id) => typeof id !== "string" || !/^src1_[a-f0-9]{40}$/.test(id),
        ))) ||
    raw.approvedBuilds.some(
      (item) =>
        !object(item) ||
        typeof item.name !== "string" ||
        typeof item.version !== "string" ||
        typeof item.sourceId !== "string" ||
        !/^src1_[a-f0-9]{40}$/.test(item.sourceId),
    )
  )
    fail("The workspace build-approval file has an unsupported format.");
  return {
    approvedBuilds: raw.approvedBuilds as PortableBuildApproval[],
    deniedBuilds: (raw.deniedBuilds ?? []) as string[],
  };
}

async function writePortableApprovals(
  project: string,
  selected: readonly BuildCandidate[],
): Promise<void> {
  const current = await readPortableApprovals(project);
  const bySource = new Map(
    current.approvedBuilds.map((item) => [item.sourceId, item]),
  );
  for (const build of selected)
    bySource.set(build.sourceId, {
      name: build.name,
      version: build.version,
      sourceId: build.sourceId,
    });
  await writeFileAtomic(
    path.join(project, WORKSPACE_POLICY_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...(current.deniedBuilds.length
          ? { deniedBuilds: current.deniedBuilds }
          : {}),
        approvedBuilds: [...bySource.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
}

/** One atomic deny file overrides portable, manifest, and legacy local grants. */
export async function revokeBuildApprovals(
  projectDir: string,
  sourceIds: readonly string[],
): Promise<{ revoked: string[] }> {
  if (
    !sourceIds.length ||
    sourceIds.some((id) => !/^src1_[a-f0-9]{40}$/.test(id))
  )
    fail(
      "Revocation requires exact source identities from zyrk approve-builds.",
    );
  const project = await realpath(projectDir);
  const control = path.join(project, ".zyrk-local");
  await mkdir(control, { recursive: true, mode: 0o700 });
  const stat = await lstat(control);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("Project approval control directory must be a real directory.");
  const held = await acquireLock(path.join(control, "project.lock"), {
    name: "build approval revocation",
  });
  try {
    const policy = await readPortableApprovals(project);
    const revoked = [...new Set(sourceIds)].sort();
    const deniedBuilds = [
      ...new Set([...policy.deniedBuilds, ...revoked]),
    ].sort();
    await writeFileAtomic(
      path.join(project, WORKSPACE_POLICY_FILE),
      JSON.stringify(
        {
          schemaVersion: 1,
          approvedBuilds: policy.approvedBuilds.filter(
            (item) => !deniedBuilds.includes(item.sourceId),
          ),
          deniedBuilds,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o644 },
    );
    return { revoked };
  } finally {
    await held.release();
  }
}
async function readUserPolicy(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  let user: unknown = {};
  try {
    user = JSON.parse(await readFile(resolveConfigFile({ env }), "utf8"));
  } catch (cause) {
    if (!isErrno(cause, "ENOENT"))
      fail("Cannot read mandatory user build policy.");
  }
  if (!object(user)) fail("Mandatory user build policy is malformed.");
  return user;
}
export async function reviewBuildCandidates(options: {
  project: string;
  env: NodeJS.ProcessEnv;
  digest: string;
  builds: readonly BuildCandidate[];
  policy: unknown;
}): Promise<BuildReview[]> {
  if (!options.builds.length) return [];
  const user = await readUserPolicy(options.env);
  let local: unknown;
  try {
    const file = path.join(options.project, ".zyrk-local", "approvals.json");
    if (!(await lstat(file)).isFile())
      fail("Build approval metadata must be a regular file.");
    local = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (cause instanceof ZyrkError) throw cause;
    local = undefined;
  }
  const portable = await readPortableApprovals(options.project);
  return options.builds.map((build) => {
    if (denied(user.scripts, build))
      return { ...build, decision: "denied", policyScope: "user-deny" };
    if (denied(options.policy, build))
      return { ...build, decision: "denied", policyScope: "project-deny" };
    if (portable.deniedBuilds.includes(build.sourceId))
      return { ...build, decision: "denied", policyScope: "workspace-deny" };
    const manifestAllowed =
      object(options.policy) &&
      Array.isArray(options.policy.allow) &&
      options.policy.allow.includes(build.sourceId);
    const workspaceAllowed = portable.approvedBuilds.some(
      (approval) => approval.sourceId === build.sourceId,
    );
    const localAllowed =
      object(local) &&
      local.schemaVersion === 1 &&
      local.candidate === options.digest &&
      Array.isArray(local.sources) &&
      local.sources.includes(build.sourceId);
    if (manifestAllowed)
      return {
        ...build,
        decision: "approved",
        policyScope: "project-policy",
      };
    if (workspaceAllowed)
      return {
        ...build,
        decision: "approved",
        policyScope: "workspace-policy",
      };
    if (localAllowed)
      return {
        ...build,
        decision: "approved",
        policyScope: "local-session",
      };
    return { ...build, decision: "pending", policyScope: "none" };
  });
}

export async function approvedCandidates(
  options: Parameters<typeof reviewBuildCandidates>[0],
): Promise<BuildCandidate[]> {
  return (await reviewBuildCandidates(options)).filter(
    (review) => review.decision === "approved",
  );
}

export async function assertApproved(options: {
  project: string;
  env: NodeJS.ProcessEnv;
  digest: string;
  builds: readonly BuildCandidate[];
  policy: unknown;
}): Promise<void> {
  const approved = await approvedCandidates(options);
  if (approved.length !== options.builds.length) {
    const pending = options.builds.find(
      (build) => !approved.some((item) => item.sourceId === build.sourceId),
    );
    fail(
      pending
        ? `Build of ${pending.name}@${pending.version} has not been approved for this exact source.`
        : "Not every dependency build candidate is approved.",
    );
  }
}
export async function materializePrivate(options: {
  project: string;
  store: Store;
  graph: GraphDoc;
  generationId: string;
}): Promise<RealizeResult> {
  const project = await realpath(options.project);
  if (!/^gen1_[a-z2-7]+$/.test(options.generationId))
    fail("Private generation identity is invalid.");
  const control = path.join(project, ".zyrk-local");
  const generations = path.join(control, "generations");
  for (const directory of [control, generations]) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) throw cause;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail("Private generation parent must be a real directory.");
  }
  const base = path.join(generations, options.generationId);
  try {
    await mkdir(base, { mode: 0o700 });
  } catch (cause) {
    if (isErrno(cause, "EEXIST"))
      fail("Private generation already exists; use a fresh identity.");
    throw cause;
  }
  const result: RealizeResult = {
    realizationDirByKey: new Map(),
    packageDirByKey: new Map(),
    created: [],
    reused: [],
  };
  const unique = new Map<string, GraphDoc["nodes"][number]>();
  for (const node of options.graph.nodes) {
    const context = contextIdFor(options.graph, node.key),
      dir = path.join(base, context),
      pkg = path.join(dir, "node_modules", ...node.name.split("/"));
    result.realizationDirByKey.set(node.key, dir);
    result.packageDirByKey.set(node.key, pkg);
    if (!unique.has(context)) {
      unique.set(context, node);
      result.created.push(context);
      await mkdir(pkg, { recursive: true });
    }
  }
  for (const node of unique.values()) {
    const pkg = result.packageDirByKey.get(node.key)!;
    const source = (await readSourceManifest(options.store, node.sourceId))
      .manifest;
    for (const e of source.entries) {
      const file = path.join(pkg, ...e.path.split("/"));
      if (e.type === "dir") {
        await mkdir(file, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(file), { recursive: true });
      if (e.type === "symlink") {
        await symlink(e.target, file);
        continue;
      }
      const verified = await verifyObjectPayload(options.store, {
        objectId: e.objectId,
        innerDigestHex: e.innerDigest,
        modeClass: e.mode,
        bytes: e.size,
      });
      if (!verified.ok)
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Cannot initialize a private graph from corrupt source.",
          { remedy: "Repair the verified source before rebuilding." },
        );
      await copyFile(
        objectPathFor(options.store, e.objectId),
        file,
        constants.COPYFILE_FICLONE,
      );
      await chmod(file, e.mode === "exec" ? 0o755 : 0o644);
      if ((await lstat(file)).nlink !== 1)
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Private generation unexpectedly shares a writable inode.",
          { remedy: "Use a filesystem supporting independent file copies." },
        );
    }
  }
  for (const node of unique.values()) {
    const context = result.realizationDirByKey.get(node.key)!,
      pkg = result.packageDirByKey.get(node.key)!;
    const names = new Set([node.name]);
    for (const edge of node.edges) {
      const target = result.packageDirByKey.get(edge.target)!;
      const slot = names.has(edge.name)
        ? path.join(pkg, "node_modules", ...edge.name.split("/"))
        : path.join(context, "node_modules", ...edge.name.split("/"));
      await mkdir(path.dirname(slot), { recursive: true });
      await symlink(target, slot);
      names.add(edge.name);
    }
  }
  return result;
}
function quote(v: string): string {
  return "'" + v.replaceAll("'", "'\\''") + "'";
}
export async function buildPrivate(options: {
  project: string;
  generationId: string;
  nodes: readonly ResolvedOccurrence[];
  builds: readonly BuildCandidate[];
  realized: RealizeResult;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (process.platform === "win32")
    throw new ZyrkError(
      "ZYRK_PLATFORM_UNSUPPORTED",
      "Dependency builds currently require a POSIX shell.",
      { remedy: "Use a supported POSIX development environment." },
    );
  const byKey = new Map(options.nodes.map((n) => [n.key, n]));
  const done = new Set<string>();
  const ordered: BuildCandidate[] = [];
  const walk = (key: string): void => {
    if (done.has(key)) return;
    done.add(key);
    for (const e of byKey.get(key)?.edges ?? []) walk(e.target);
    const b = options.builds.find((x) => x.key === key);
    if (b) ordered.push(b);
  };
  for (const n of options.nodes) walk(n.key);
  const builtDirectories = new Set<string>();
  for (const build of ordered) {
    const pkg = await realpath(
      options.realized.packageDirByKey.get(build.key)!,
    );
    if (builtDirectories.has(pkg)) continue;
    builtDirectories.add(pkg);
    const bindir = path.join(
      options.realized.realizationDirByKey.get(build.key)!,
      "node_modules",
      ".bin",
    );
    await mkdir(bindir, { recursive: true });
    for (const edge of byKey.get(build.key)?.edges ?? []) {
      const child = byKey.get(edge.target)!;
      const root = options.realized.packageDirByKey.get(child.key)!;
      for (const [name, target] of Object.entries(child.bin)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
          fail("A dependency has an unsafe executable name.");
        const file = await realpath(path.resolve(root, target));
        if (!file.startsWith(root + path.sep))
          fail("A dependency binary escapes the private graph.");
        await writeFileAtomic(
          path.join(bindir, name),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(file)} "$@"\n`,
          { mode: 0o755 },
        );
      }
    }
    for (const stage of build.stages) {
      const env = {
        ...options.env,
        PATH: bindir + path.delimiter + (options.env.PATH ?? ""),
        INIT_CWD: options.project,
        npm_lifecycle_event: stage.name,
        npm_lifecycle_script: stage.command,
        npm_package_json: path.join(pkg, "package.json"),
        npm_execpath: path.resolve(import.meta.dirname, "../../bin/zyrk.js"),
        npm_config_user_agent: `zyrk node/${process.version} ${process.platform} ${process.arch}`,
      };
      const outcome = await superviseChild("/bin/sh", ["-c", stage.command], {
        cwd: pkg,
        env,
        capture: true,
      });
      await writeFileAtomic(
        path.join(
          options.project,
          ".zyrk-local",
          "generations",
          options.generationId,
          `${sha512Hex(build.key + stage.name).slice(0, 24)}.log`,
        ),
        redactSecrets(outcome.stdout + outcome.stderr),
        { mode: 0o600 },
      );
      if (outcome.exitCode !== 0)
        throw new ZyrkError(
          "ZYRK_BUILD_FAILED",
          `Dependency ${build.name}@${build.version} failed its ${stage.name} build.`,
          {
            remedy:
              "Inspect the private build log and fix the required toolchain or dependency before retrying. The previous generation remains selected.",
            detail: { exitCode: outcome.exitCode },
          },
        );
    }
  }
}
