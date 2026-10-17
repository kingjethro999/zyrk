import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { lockedGraph } from "../install/lock.ts";
import type { NpmLockDoc } from "../lockfile/types.ts";
import { Store } from "../store/layout.ts";
import { readSourceManifest } from "../store/manifests.ts";
import { objectPathFor, verifyObjectPayload } from "../store/objects.ts";
import { isErrno, writeFileAtomic } from "../util/fsx.ts";
import { modeClassOf, sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { randomId } from "../util/ids.ts";
import { acquireLock } from "../util/locks.ts";

type Change = {
  path: string;
  before: string | null;
  content: string | null;
  executable: boolean;
};
export type ProjectPatch = {
  schemaVersion: 1;
  sourceId: string;
  manifestHash: string;
  changes: Change[];
};
export type LoadedProjectPatch = ProjectPatch & {
  digest: string;
  artifact: string;
};
type Manifest = {
  zyrk?: { patches?: Record<string, string>; [key: string]: unknown };
  [key: string]: unknown;
};
function fail(why: string): never {
  throw new ZyrkError(
    "ZYRK_MANIFEST_INVALID",
    `Cannot process dependency patch: ${why}.`,
    {
      remedy:
        "Use a patch editing area created by zyrk, keep changes inside the intended package, and reinstall after committing the patch.",
    },
  );
}
function relative(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("unsafe package-relative path");
  return value;
}
async function readJson(file: string): Promise<unknown> {
  if (!(await fs.lstat(file)).isFile()) fail("metadata is not a regular file");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fail("invalid JSON metadata");
  }
}
async function manifest(project: string): Promise<Manifest> {
  return (await readJson(path.join(project, "package.json"))) as Manifest;
}
async function safeParent(root: string, relativePath: string, create: boolean) {
  relative(relativePath);
  let current = root;
  if (!(await fs.lstat(root)).isDirectory())
    fail("package root is not a real directory");
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      if (!(await fs.lstat(current)).isDirectory())
        fail("path crosses a link or file");
    } catch (error) {
      if (!create || !isErrno(error, "ENOENT")) throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
  return path.join(root, ...relativePath.split("/"));
}
function scanSecrets(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|https?:\/\/[^\s/@]+:[^\s/@]+@/.test(
      text,
    )
  )
    fail("patch contains credential-like content");
}

export async function loadProjectPatches(
  project: string,
): Promise<LoadedProjectPatch[]> {
  const config = (await manifest(project)).zyrk?.patches;
  if (config === undefined) return [];
  if (!config || typeof config !== "object" || Array.isArray(config))
    fail("zyrk.patches must map source identities to artifact paths");
  const result: LoadedProjectPatch[] = [];
  for (const sourceId of Object.keys(config).sort()) {
    const artifact = config[sourceId];
    if (typeof artifact !== "string" || !artifact.startsWith(".zyrk/patches/"))
      fail("patch artifact must live in .zyrk/patches");
    const file = await safeParent(project, artifact, false);
    const raw = (await readJson(file)) as ProjectPatch;
    if (
      !raw ||
      raw.schemaVersion !== 1 ||
      raw.sourceId !== sourceId ||
      typeof raw.manifestHash !== "string" ||
      !/^[0-9a-f]{128}$/.test(raw.manifestHash) ||
      !Array.isArray(raw.changes)
    )
      fail("patch source binding is invalid");
    const seen = new Set<string>();
    for (const change of raw.changes) {
      if (!change || typeof change.path !== "string") fail("invalid change");
      relative(change.path);
      if (seen.has(change.path)) fail("duplicate change");
      seen.add(change.path);
      if (
        change.before !== null &&
        (typeof change.before !== "string" ||
          !/^[0-9a-f]{128}$/.test(change.before))
      )
        fail("invalid original file digest");
      if (
        typeof change.executable !== "boolean" ||
        (change.content !== null &&
          (typeof change.content !== "string" ||
            Buffer.from(change.content, "base64").toString("base64") !==
              change.content))
      )
        fail("invalid file delta");
      if (change.content !== null)
        scanSecrets(Buffer.from(change.content, "base64"));
    }
    result.push({ ...raw, artifact, digest: sha512Hex(canonicalJson(raw)) });
  }
  return result;
}
export async function hasProjectPatches(project: string): Promise<boolean> {
  return (await loadProjectPatches(project)).length > 0;
}

/** Caller supplies the complete private generation, copied/reflinked without store hardlinks. */
export async function applyProjectPatches(options: {
  project: string;
  store: Store;
  packages: ReadonlyMap<string, { sourceId: string; directory: string }>;
}): Promise<{ digest: string; count: number }> {
  const project = await fs.realpath(options.project);
  const patches = await loadProjectPatches(project);
  let count = 0;
  for (const patch of patches) {
    if (
      (await readSourceManifest(options.store, patch.sourceId)).manifestHash !==
      patch.manifestHash
    )
      fail(
        "patch source manifest binding disagrees with the selected verified source",
      );
    const targets = [...options.packages.values()].filter(
      (pkg) => pkg.sourceId === patch.sourceId,
    );
    if (!targets.length)
      fail("patched source is absent from the selected graph");
    const seenDirectories = new Set<string>();
    for (const pkg of targets) {
      if (seenDirectories.has(pkg.directory)) continue;
      seenDirectories.add(pkg.directory);
      const root = await fs.realpath(pkg.directory);
      if (
        !root.startsWith(`${project}${path.sep}`) ||
        !root.startsWith(
          path.join(project, ".zyrk-local", "generations") + path.sep,
        )
      )
        fail("patch destination is outside the private generation");
      for (const change of patch.changes) {
        const target = await safeParent(root, change.path, true);
        let before: Buffer | null = null;
        try {
          const stat = await fs.lstat(target);
          if (!stat.isFile() || stat.nlink > 1)
            fail("patch target is a link or shares an inode");
          before = await fs.readFile(target);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        if ((before === null ? null : sha512Hex(before)) !== change.before)
          fail("original file digest differs from patch");
        if (change.content === null) {
          if (before !== null) await fs.unlink(target);
        } else
          await writeFileAtomic(target, Buffer.from(change.content, "base64"), {
            mode: change.executable ? 0o755 : 0o644,
          });
      }
      count++;
    }
  }
  return {
    digest: sha512Hex(
      canonicalJson(
        patches.map(({ sourceId, digest }) => ({ sourceId, digest })),
      ),
    ),
    count,
  };
}

export async function runPatchCommand(options: {
  command: "patch" | "patch-commit";
  args: readonly string[];
  store: Store;
  cwd: string;
}): Promise<unknown> {
  if (options.args.length !== 1 || !options.args[0])
    fail("expected one package selector or editing-area path");
  const project = await fs.realpath(options.cwd);
  const control = path.join(project, ".zyrk-local");
  try {
    if (!(await fs.lstat(control)).isDirectory())
      fail("project control directory is not a real directory");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await fs.mkdir(control, { mode: 0o700 });
  }
  const held = await acquireLock(path.join(control, "project.lock"), {
    name: "project patch",
  });
  try {
    return options.command === "patch"
      ? await createEditingArea(project, options.args[0], options.store)
      : await commitPatch(project, options.args[0], options.store);
  } finally {
    await held.release();
  }
}
async function createEditingArea(
  project: string,
  selector: string,
  store: Store,
) {
  const graph = lockedGraph(
    (await readJson(path.join(project, "package-lock.json"))) as NpmLockDoc,
  );
  const matches = graph.nodes.filter(
    (node) =>
      node.name === selector ||
      `${node.name}@${node.version}` === selector ||
      node.key === selector,
  );
  const ids = [...new Set(matches.map((node) => node.sourceId))];
  if (ids.length !== 1 || !ids[0])
    fail("selector must identify exactly one installed source");
  const sourceId = ids[0];
  const doc = await readSourceManifest(store, sourceId);
  const base = path.join(project, ".zyrk-local", "patch-work");
  await safeParent(project, ".zyrk-local/patch-work/placeholder", true);
  const editingArea = path.join(base, randomId("edit1_"));
  await fs.mkdir(editingArea, { mode: 0o700 });
  const packageRoot = path.join(editingArea, "package");
  await fs.mkdir(packageRoot, { mode: 0o700 });
  for (const entry of doc.manifest.entries) {
    const target = await safeParent(packageRoot, entry.path, true);
    if (entry.type === "dir")
      await fs.mkdir(target, { recursive: true, mode: 0o755 });
    else if (entry.type === "symlink") await fs.symlink(entry.target, target);
    else {
      const object = objectPathFor(store, entry.objectId);
      if (!(await fs.lstat(object)).isFile())
        fail("source object is not a regular file");
      const verified = await verifyObjectPayload(store, {
        objectId: entry.objectId,
        innerDigestHex: entry.innerDigest,
        modeClass: entry.mode,
        bytes: entry.size,
      });
      if (!verified.ok) fail("source payload verification failed");
      await fs.copyFile(object, target);
      await fs.chmod(target, entry.mode === "exec" ? 0o755 : 0o644);
    }
  }
  await writeFileAtomic(
    path.join(editingArea, "edit.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceId,
      manifestHash: doc.manifestHash,
    }),
    { mode: 0o600 },
  );
  return {
    editingArea: packageRoot,
    sourceId,
    next: "Edit these private files, then run zyrk patch-commit <editing-area>.",
  };
}
async function commitPatch(project: string, argument: string, store: Store) {
  let area = await fs.realpath(path.resolve(project, argument));
  if (path.basename(area) === "package") area = path.dirname(area);
  const base = path.join(project, ".zyrk-local", "patch-work");
  if (path.dirname(area) !== base) fail("editing area is outside this project");
  const info = (await readJson(path.join(area, "edit.json"))) as {
    sourceId: string;
    manifestHash: string;
  };
  if (
    !info ||
    typeof info.sourceId !== "string" ||
    !/^[a-z0-9_]+$/.test(info.sourceId)
  )
    fail("invalid editing source identity");
  const original = await readSourceManifest(store, info.sourceId);
  if (original.manifestHash !== info.manifestHash)
    fail("source manifest changed");
  const edited = new Map<string, { bytes: Buffer; executable: boolean }>();
  const originalEntries = new Map(
    original.manifest.entries.map((entry) => [entry.path, entry]),
  );
  const walk = async (directory: string, prefix: string): Promise<void> => {
    if (!(await fs.lstat(directory)).isDirectory())
      fail("editing root is not a real directory");
    for (const name of (await fs.readdir(directory)).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(directory, name);
      const stat = await fs.lstat(full);
      if (stat.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const old = originalEntries.get(rel);
        if (
          !old ||
          old.type !== "symlink" ||
          (await fs.readlink(full)) !== old.target
        )
          fail("symlink edits are unsupported");
        continue;
      }
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        fail("unsupported or oversized edited file");
      const bytes = await fs.readFile(full);
      scanSecrets(bytes);
      edited.set(relative(rel), {
        bytes,
        executable: modeClassOf(stat.mode) === "exec",
      });
    }
  };
  await walk(path.join(area, "package"), "");
  const changes: Change[] = [];
  for (const [name, old] of originalEntries) {
    if (old.type === "symlink") {
      try {
        if (
          !(
            await fs.lstat(path.join(area, "package", ...name.split("/")))
          ).isSymbolicLink()
        )
          fail("symlink edits are unsupported");
      } catch {
        fail("symlink edits are unsupported");
      }
    }
  }
  const files = new Set([
    ...original.manifest.entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path),
    ...edited.keys(),
  ]);
  for (const name of [...files].sort()) {
    const old = originalEntries.get(name);
    if (old && old.type !== "file") fail("entry type changes are unsupported");
    const next = edited.get(name);
    const digest = next ? sha512Hex(next.bytes) : null;
    if (
      old?.innerDigest === digest &&
      (old.mode === "exec") === next?.executable
    )
      continue;
    changes.push({
      path: name,
      before: old?.innerDigest ?? null,
      content: next?.bytes.toString("base64") ?? null,
      executable: next?.executable ?? false,
    });
  }
  const patch: ProjectPatch = {
    schemaVersion: 1,
    sourceId: info.sourceId,
    manifestHash: info.manifestHash,
    changes,
  };
  const digest = sha512Hex(canonicalJson(patch));
  const artifact = `.zyrk/patches/${digest}.json`;
  const file = await safeParent(project, artifact, true);
  await writeFileAtomic(file, `${canonicalJson(patch)}\n`, { mode: 0o644 });
  const config = await manifest(project);
  config.zyrk = {
    ...config.zyrk,
    patches: { ...config.zyrk?.patches, [info.sourceId]: artifact },
  };
  await writeFileAtomic(
    path.join(project, "package.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o644 },
  );
  return {
    artifact,
    digest,
    sourceId: info.sourceId,
    changedFiles: changes.length,
    next: "Commit the artifact and package.json, then reinstall to apply it to a private project generation.",
  };
}
