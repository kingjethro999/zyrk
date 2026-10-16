import {
  open,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink as fsSymlink,
} from "node:fs/promises";
import * as path from "node:path";
import { ZyrkError } from "../errors.ts";
import { acquireLock } from "../util/locks.ts";
import {
  ensureDirWithMode,
  isErrno,
  mkdirp,
  pathExists,
  rmrfNoFollow,
  writeFileAtomic,
} from "../util/fsx.ts";
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
 * Local state lives under `<project>/.zyrk-local/`, is never required to
 * clone and reinstall, and is never copied into a lockfile.
 */

export const PROJECT_STATE_DIR = ".zyrk-local";

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
  metadataOnly?: boolean;
  files?: Array<{
    name: "package.json" | "package-lock.json";
    before: string | null;
    after: string;
  }>;
};

function journalPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_STATE_DIR, "journal.jsonl");
}

function lockPath(projectDir: string): string {
  return path.join(projectDir, PROJECT_STATE_DIR, "project.lock");
}

async function appendEvent(
  projectDir: string,
  event: ProjectionEvent,
): Promise<void> {
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
      const event = JSON.parse(line) as ProjectionEvent;
      if (!/^gen1_[a-zA-Z0-9_-]+$/.test(event.generationId))
        throw new Error("invalid generation");
      if (
        event.files?.some(
          (file) =>
            !["package.json", "package-lock.json"].includes(file.name) ||
            (file.before !== null && typeof file.before !== "string") ||
            typeof file.after !== "string",
        )
      )
        throw new Error("invalid files");
      events.push(event);
    } catch (error) {
      if (!(error instanceof SyntaxError))
        throw new ZyrkError(
          "ZYRK_STORE_CORRUPT",
          "Project recovery journal is malformed.",
          { remedy: "Restore the local journal before retrying installation." },
        );
      // A torn final append may be ignored; durable earlier events remain.
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
    if (name.startsWith("node_modules.zyrk-staging-")) {
      await rmrfNoFollow(path.join(projectDir, name));
    }
  }

  if (last === undefined) return;
  const previous = path.join(
    projectDir,
    `node_modules.zyrk-old-${last.generationId}`,
  );
  if (await pathExists(previous)) {
    if (!(await pathExists(nodeModules))) {
      // The swap had moved the old projection aside but never published a
      // replacement: put the old complete projection back.
      await rename(previous, nodeModules);
    } else {
      await rmrfNoFollow(previous);
    }
  }
  const staged = events.find(
    (event) =>
      event.generationId === last.generationId && event.files !== undefined,
  );
  if (staged?.files) {
    let active: unknown;
    try {
      active = JSON.parse(
        await readFile(
          path.join(nodeModules, ".zyrk", "install-state.json"),
          "utf8",
        ),
      );
    } catch {
      active = null;
    }
    const published =
      staged.metadataOnly === true
        ? last.event === "done"
        : (active as { generationId?: unknown } | null)?.generationId ===
          last.generationId;
    for (const file of staged.files) {
      const contents = published ? file.after : file.before;
      if (contents === null)
        await rm(path.join(projectDir, file.name), { force: true });
      else
        await writeFileAtomic(path.join(projectDir, file.name), contents, {
          mode: 0o644,
        });
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
  options: {
    projectId?: string;
    generationId?: string;
    lockHeld?: boolean;
    bins?: Record<string, string>;
    files?: Array<{
      name: "package.json" | "package-lock.json";
      contents: string;
    }>;
    readiness?: "ready" | "intentionally-unbuilt";
    metadata?: Record<string, unknown>;
  } = {},
): Promise<ProjectionResult> {
  const lock = options.lockHeld
    ? undefined
    : await acquireLock(lockPath(projectDir), { name: "project mutation" });
  try {
    await recoverProjection(projectDir);

    const generationId = options.generationId ?? `gen1_${randomId("", 12)}`;
    const staging = path.join(
      projectDir,
      `node_modules.zyrk-staging-${generationId}`,
    );
    const previous = path.join(
      projectDir,
      `node_modules.zyrk-old-${generationId}`,
    );
    const nodeModules = path.join(projectDir, "node_modules");

    await ensureDirWithMode(staging, 0o755);
    for (const entry of entries) {
      if (
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
          entry.name,
        ) ||
        entry.name === "node_modules"
      )
        throw new ZyrkError(
          "ZYRK_MANIFEST_INVALID",
          "Unsafe projection dependency name.",
          { remedy: "Use a valid registry package name." },
        );
      const target = path.join(staging, ...entry.name.split("/"));
      await mkdirp(path.dirname(target));
      await fsSymlink(entry.linkTarget, target);
    }

    if (Object.keys(options.bins ?? {}).length) {
      await mkdirp(path.join(staging, ".bin"));
      for (const [name, target] of Object.entries(options.bins ?? {})) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
          throw new ZyrkError("ZYRK_MANIFEST_INVALID", "Unsafe binary name.", {
            remedy: "Use a package with safe bin entries.",
          });
        const stat = await lstat(target);
        if ((stat.mode & 0o111) !== 0)
          await fsSymlink(target, path.join(staging, ".bin", name));
        else {
          const quote = (value: string): string =>
            "'" + value.replaceAll("'", "'\\''") + "'";
          const firstLine =
            (await readFile(target, "utf8")).split("\n")[0] ?? "";
          if (!firstLine.includes("node") && !/\.(?:[cm]?js|ts)$/.test(target))
            throw new ZyrkError(
              "ZYRK_MANIFEST_INVALID",
              "Non-executable dependency bin has no Node entry point.",
              { remedy: "Select a package shipping executable bin files." },
            );
          await writeFileAtomic(
            path.join(staging, ".bin", name),
            `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(target)} "$@"\n`,
            { mode: 0o755 },
          );
        }
      }
    }
    await ensureDirWithMode(path.join(staging, ".zyrk"), 0o755);
    const state = {
      schemaVersion: 1,
      generationId,
      ...(options.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
      linker: "shared",
      createdAt: new Date().toISOString(),
      readiness: options.readiness ?? "ready",
      ...options.metadata,
      direct: entries.map((entry) => ({
        name: entry.name,
        target: entry.linkTarget,
      })),
    };
    await writeFileAtomic(
      path.join(staging, ".zyrk", "install-state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      {
        mode: 0o644,
      },
    );
    const files = [];
    for (const file of options.files ?? []) {
      let before: string | null = null;
      try {
        before = await readFile(path.join(projectDir, file.name), "utf8");
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      files.push({ name: file.name, before, after: file.contents });
    }
    await appendEvent(projectDir, {
      at: new Date().toISOString(),
      event: "staged",
      generationId,
      files,
    });
    for (const file of files)
      await writeFileAtomic(path.join(projectDir, file.name), file.after, {
        mode: 0o644,
      });

    const hadPrevious = await pathExists(nodeModules);
    if (hadPrevious) {
      await rename(nodeModules, previous);
      await appendEvent(projectDir, {
        at: new Date().toISOString(),
        event: "old-moved",
        generationId,
      });
    }
    await rename(staging, nodeModules);
    await appendEvent(projectDir, {
      at: new Date().toISOString(),
      event: "published",
      generationId,
    });

    if (hadPrevious) await rmrfNoFollow(previous);
    await appendEvent(projectDir, {
      at: new Date().toISOString(),
      event: "done",
      generationId,
    });
    await rm(journalPath(projectDir), { force: true });

    return { nodeModulesDir: nodeModules, generationId };
  } finally {
    await lock?.release();
  }
}

/** Journal metadata-only changes while the caller holds the project lock. */
export async function installMetadata(
  projectDir: string,
  files: Array<{
    name: "package.json" | "package-lock.json";
    contents: string;
  }>,
): Promise<void> {
  const generationId = `gen1_${randomId("", 12)}`;
  const snapshots = [];
  for (const file of files) {
    let before: string | null = null;
    try {
      before = await readFile(path.join(projectDir, file.name), "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    snapshots.push({ name: file.name, before, after: file.contents });
  }
  await appendEvent(projectDir, {
    at: new Date().toISOString(),
    event: "staged",
    generationId,
    metadataOnly: true,
    files: snapshots,
  });
  for (const file of snapshots)
    await writeFileAtomic(path.join(projectDir, file.name), file.after, {
      mode: 0o644,
    });
  await appendEvent(projectDir, {
    at: new Date().toISOString(),
    event: "done",
    generationId,
  });
  await rm(journalPath(projectDir), { force: true });
}
