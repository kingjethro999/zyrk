import { open, readFile, readdir, rename, rm, symlink as fsSymlink } from "node:fs/promises";
import * as path from "node:path";
import { acquireLock } from "../util/locks.ts";
import { ensureDirWithMode, isErrno, mkdirp, pathExists, rmrfNoFollow, writeFileAtomic } from "../util/fsx.ts";
import { randomId } from "../util/ids.ts";
import { canonicalJson } from "../util/json.ts";

/**
 * Project projection: direct dependency links plus `.bin` and install state
 * (SPEC 10.3, 14.3). The projection is replaced transactionally: a staging
 * tree is built next to `node_modules`, the previous generation is moved
 * aside, the staged tree is renamed into place, and only then is the old
 * generation removed. A crash leaves either the old complete projection or
 * the new complete projection; recovery reads the journal and the filesystem
 * together (SPEC 17.3).
 *
 * Local state lives under `<project>/.snpm-local/`, is never required to
 * clone and reinstall, and is never copied into a lockfile.
 */

export const PROJECT_STATE_DIR = ".snpm-local";

export type ProjectionEntry = {
  /** Dependency name as it appears under `node_modules` (alias-aware). */
  name: string;
  /** Absolute package directory inside its shared realization. */
  linkTarget: string;
};

export type ProjectionResult = {
  nodeModulesDir: string;
  generationId: string;
};

type ProjectionEvent = {
  at: string;
  event: "staged" | "old-moved" | "published" | "done";
  generationId: string;
};

function journalPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_STATE_DIR, "journal.jsonl");
}

function lockPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_STATE_DIR, "project.lock");
}

async function appendEvent(projectDir: string, event: ProjectionEvent): Promise<void> {
  const target = journalPath(projectDir);
  await mkdirp(path.dirname(target));
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${canonicalJson(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readEvents(projectDir: string): Promise<ProjectionEvent[]> {
  let text: string;
  try {
    text = await readFile(journalPath(projectDir), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const events: ProjectionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      events.push(JSON.parse(line) as ProjectionEvent);
    } catch {
      // A torn final line after a crash is expected; earlier lines stand.
    }
  }
  return events;
}

/**
 * Bring the project back to a complete projection after an interrupted
 * install, then clear the journal. Callers must hold the project lock.
 */
export async function recoverProjection(projectDir: string): Promise<void> {
  const events = await readEvents(projectDir);
  const last = events.at(-1);
  const nodeModules = path.join(projectDir, "node_modules");

  let names: string[] = [];
  try {
    names = await readdir(projectDir);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  // Staging trees from an interrupted run are never live: the journaled swap
  // is the only path that can publish one.
  for (const name of names) {
    if (name.startsWith("node_modules.snpm-staging-")) {
      await rmrfNoFollow(path.join(projectDir, name));
    }
  }

  if (last === undefined) return;
  const previous = path.join(projectDir, `node_modules.snpm-old-${last.generationId}`);
  if (await pathExists(previous)) {
    if (!(await pathExists(nodeModules))) {
      // The swap had moved the old projection aside but never published a
      // replacement: put the old complete projection back.
      await rename(previous, nodeModules);
    } else {
      await rmrfNoFollow(previous);
    }
  }
  await rm(journalPath(projectDir), { force: true });
}

/**
 * Publish a projection for `entries` under the project lock. Replaces a
 * previous projection only after the new one is fully staged.
 */
export async function installProjection(
  projectDir: string,
  entries: ProjectionEntry[],
  options: { projectId?: string } = {},
): Promise<ProjectionResult> {
  const lock = await acquireLock(lockPath(projectDir), { name: "project mutation" });
  try {
    await recoverProjection(projectDir);

    const generationId = `gen1_${randomId("", 12)}`;
    const staging = path.join(projectDir, `node_modules.snpm-staging-${generationId}`);
    const previous = path.join(projectDir, `node_modules.snpm-old-${generationId}`);
    const nodeModules = path.join(projectDir, "node_modules");

    await ensureDirWithMode(staging, 0o755);
    for (const entry of entries) {
      const target = path.join(staging, ...entry.name.split("/"));
      await mkdirp(path.dirname(target));
      await fsSymlink(entry.linkTarget, target);
    }

    await ensureDirWithMode(path.join(staging, ".snpm"), 0o755);
    const state = {
      schemaVersion: 1,
      generationId,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      linker: "shared",
      createdAt: new Date().toISOString(),
      readiness: "ready",
      direct: entries.map((entry) => ({ name: entry.name, target: entry.linkTarget })),
    };
    await writeFileAtomic(path.join(staging, ".snpm", "install-state.json"), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o644,
    });
    await appendEvent(projectDir, { at: new Date().toISOString(), event: "staged", generationId });

    const hadPrevious = await pathExists(nodeModules);
    if (hadPrevious) {
      await rename(nodeModules, previous);
      await appendEvent(projectDir, { at: new Date().toISOString(), event: "old-moved", generationId });
    }
    await rename(staging, nodeModules);
    await appendEvent(projectDir, { at: new Date().toISOString(), event: "published", generationId });

    if (hadPrevious) await rmrfNoFollow(previous);
    await appendEvent(projectDir, { at: new Date().toISOString(), event: "done", generationId });
    await rm(journalPath(projectDir), { force: true });

    return { nodeModulesDir: nodeModules, generationId };
  } finally {
    await lock.release();
  }
}
