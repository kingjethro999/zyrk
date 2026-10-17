/** One durable publication decision covers every importer and the authoritative lock. */
import { lstat, readFile, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import {
  isErrno,
  fsyncDir,
  writeFileAtomic,
  rmrfNoFollow,
} from "../util/fsx.ts";
import { safeImporter } from "./workspace-lock.ts";
import { lockMismatch } from "./lock.ts";
export type WorkspaceManifestChange = {
  id: string;
  before: string;
  after: string;
};
export type WorkspaceJournal = {
  metadataOnly?: boolean;
  manifests?: WorkspaceManifestChange[];
  version: 1;
  generationId: string;
  committed: boolean;
  lockBefore: string | null;
  lockAfter: string;
  importers: Array<{ id: string; hadBefore: boolean }>;
};
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return false;
    throw cause;
  }
}
const journal = (root: string) =>
  path.join(root, ".zyrk-local", "workspace-journal.json");
export function workspaceProjectionPaths(
  root: string,
  id: string,
  generationId: string,
) {
  const base = id === "." ? root : path.join(root, id);
  return {
    active: path.join(base, "node_modules"),
    staged: path.join(base, `node_modules.zyrk-ws-staging-${generationId}`),
    previous: path.join(base, `node_modules.zyrk-ws-old-${generationId}`),
  };
}
async function validate(
  root: string,
  value: unknown,
): Promise<WorkspaceJournal> {
  const j = value as WorkspaceJournal;
  if (
    !j ||
    Object.keys(j).some(
      (k) =>
        ![
          "metadataOnly",
          "manifests",
          "version",
          "generationId",
          "committed",
          "lockBefore",
          "lockAfter",
          "importers",
        ].includes(k),
    ) ||
    (j.metadataOnly !== undefined && typeof j.metadataOnly !== "boolean") ||
    j.version !== 1 ||
    typeof j.generationId !== "string" ||
    !/^gen1_[a-z2-7]+$/.test(j.generationId) ||
    typeof j.committed !== "boolean" ||
    (j.lockBefore !== null && typeof j.lockBefore !== "string") ||
    typeof j.lockAfter !== "string" ||
    !Array.isArray(j.importers) ||
    j.importers.length > 10000
  )
    throw lockMismatch("invalid workspace recovery journal");
  const seen = new Set<string>();
  for (const importer of j.importers) {
    if (
      !importer ||
      Object.keys(importer).some((k) => !["id", "hadBefore"].includes(k)) ||
      !safeImporter(importer.id) ||
      typeof importer.hadBefore !== "boolean" ||
      seen.has(importer.id)
    )
      throw lockMismatch("unsafe workspace recovery importer");
    seen.add(importer.id);
    let current = root;
    if (importer.id !== ".")
      for (const component of importer.id.split("/")) {
        current = path.join(current, component);
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw lockMismatch("workspace recovery directory is not real");
      }
  }
  if (!seen.has(".")) throw lockMismatch("workspace recovery root is missing");
  const manifestIds = new Set<string>();
  if (j.manifests !== undefined) {
    if (!Array.isArray(j.manifests) || j.manifests.length > j.importers.length)
      throw lockMismatch("invalid workspace manifest snapshots");
    for (const file of j.manifests) {
      if (
        !file ||
        Object.keys(file).some((k) => !["id", "before", "after"].includes(k)) ||
        !safeImporter(file.id) ||
        !seen.has(file.id) ||
        manifestIds.has(file.id) ||
        typeof file.before !== "string" ||
        typeof file.after !== "string"
      )
        throw lockMismatch("unsafe workspace manifest snapshot");
      manifestIds.add(file.id);
    }
  }
  return j;
}
export async function recoverWorkspaceProjection(root: string): Promise<void> {
  const control = await lstat(path.join(root, ".zyrk-local"));
  if (!control.isDirectory() || control.isSymbolicLink())
    throw lockMismatch("workspace control directory is not real");
  let journalStat;
  try {
    journalStat = await lstat(journal(root));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return;
    throw cause;
  }
  if (!journalStat.isFile() || journalStat.isSymbolicLink())
    throw lockMismatch("workspace journal must be a regular file");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(journal(root), "utf8"));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return;
    throw lockMismatch("cannot read workspace recovery journal");
  }
  const j = await validate(root, raw);
  for (const importer of j.metadataOnly ? [] : j.importers) {
    const p = workspaceProjectionPaths(root, importer.id, j.generationId);
    if (!j.committed) {
      if (await exists(p.previous)) {
        await rmrfNoFollow(p.active);
        await rename(p.previous, p.active);
        await fsyncDir(path.dirname(p.active));
      } else if (!importer.hadBefore) {
        await rmrfNoFollow(p.active);
      }
    } else await rmrfNoFollow(p.previous);
    await rmrfNoFollow(p.staged);
    await fsyncDir(path.dirname(p.active));
  }
  for (const file of j.manifests ?? [])
    await writeFileAtomic(
      path.join(root, file.id === "." ? "" : file.id, "package.json"),
      j.committed ? file.after : file.before,
      { mode: 0o644 },
    );
  const text = j.committed ? j.lockAfter : j.lockBefore;
  if (text === null)
    await rm(path.join(root, "package-lock.json"), { force: true });
  else
    await writeFileAtomic(path.join(root, "package-lock.json"), text, {
      mode: 0o644,
    });
  await fsyncDir(root);
  await rm(journal(root), { force: true });
  await fsyncDir(path.dirname(journal(root)));
}
export async function publishWorkspaceProjection(
  root: string,
  generationId: string,
  ids: readonly string[],
  lockAfter: string,
  manifests: WorkspaceManifestChange[] = [],
  metadataOnly = false,
): Promise<void> {
  const control = await lstat(path.join(root, ".zyrk-local"));
  if (!control.isDirectory() || control.isSymbolicLink())
    throw lockMismatch("workspace control directory is not real");
  let lockBefore: string | null = null;
  try {
    lockBefore = await readFile(path.join(root, "package-lock.json"), "utf8");
  } catch (cause) {
    if (!isErrno(cause, "ENOENT")) throw cause;
  }
  const j: WorkspaceJournal = {
    version: 1,
    generationId,
    committed: false,
    lockBefore,
    lockAfter,
    importers: [],
    manifests,
    metadataOnly,
  };
  for (const id of ids)
    j.importers.push({
      id,
      hadBefore: await exists(
        workspaceProjectionPaths(root, id, generationId).active,
      ),
    });
  await validate(root, j);
  await writeFileAtomic(journal(root), JSON.stringify(j), { mode: 0o600 });
  try {
    for (const importer of metadataOnly ? [] : j.importers) {
      const p = workspaceProjectionPaths(root, importer.id, generationId);
      if (importer.hadBefore) await rename(p.active, p.previous);
      await rename(p.staged, p.active);
      await fsyncDir(path.dirname(p.active));
    }
    for (const file of manifests)
      await writeFileAtomic(
        path.join(root, file.id === "." ? "" : file.id, "package.json"),
        file.after,
        { mode: 0o644 },
      );
    await writeFileAtomic(path.join(root, "package-lock.json"), lockAfter, {
      mode: 0o644,
    });
    j.committed = true;
    await writeFileAtomic(journal(root), JSON.stringify(j), { mode: 0o600 });
  } finally {
    await recoverWorkspaceProjection(root);
  }
}
