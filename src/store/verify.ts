/**
 * Realization verification before reuse (S01, SPEC 11.7, I-001/I-014).
 *
 * An existing realization directory is never trusted by existence alone:
 * restored caches, tooling accidents, or local corruption can change bytes,
 * replace files, add entries, or retarget dependency links without touching
 * the content-addressed objects they were built from. Before a reused
 * realization backs execution, this module checks the exact tree:
 *
 * - source identity matches the node's recorded name, version, and source
 * - every manifest file exists with the recorded size, sha512 digest, and
 *   normalized mode class (files are hashed directly: a replaced file
 *   shares no inode with its object, so only direct hashing proves the
 *   bytes about to execute are the verified ones)
 * - manifest directories and symlinks exist with the recorded type and
 *   exact link target text
 * - every dependency slot holds a symlink with the exact recorded target;
 *   changed targets fail, including transitive children reached through
 *   the graph
 * - no extra files, directories, symlinks, or special entries exist
 *   anywhere in the context (real directories are allowed only when the
 *   manifest lists them or when they are strict ancestors of covered
 *   paths, since extraction creates implied parents without recording
 *   them)
 *
 * Any mismatch fails with NEXU_STORE_CORRUPT and changes nothing: suspect
 * content is never repaired in place and never executed. Fail-closed is
 * deliberate; the repair protocol that rebuilds replacements at new paths
 * is a later milestone.
 */

import { lstat, readdir, readlink } from "node:fs/promises";
import * as path from "node:path";
import { NexuError } from "../errors.ts";
import { isErrno } from "../util/fsx.ts";
import { modeClassOf, sha512HexOfFile } from "../util/hash.ts";
import { contextIdFor, type GraphDoc, type GraphNode } from "./graph.ts";
import { Store } from "./layout.ts";
import { readSourceManifest, type ManifestEntry } from "./manifests.ts";
import { packageDirIn, realizationDirFor } from "./realize.ts";

export type VerifyRealizationOptions = {
  store: Store;
  graph: GraphDoc;
  rootKey: string;
  contextId: string;
};

export async function verifyRealization(
  options: VerifyRealizationOptions,
): Promise<void> {
  const { store, graph, rootKey, contextId } = options;
  const node = graph.nodes.find((candidate) => candidate.key === rootKey);
  if (node === undefined) throw internal(`unknown context root ${rootKey}`);
  if (contextIdFor(graph, rootKey) !== contextId) {
    throw internal(`context mismatch: ${rootKey} is not ${contextId}`);
  }
  const checker = new RealizationChecker(store, graph, node, contextId);
  await checker.run();
}

type SlotMap = Map<string, string>;

class RealizationChecker {
  private readonly store: Store;
  private readonly graph: GraphDoc;
  private readonly node: GraphNode;
  private readonly contextId: string;
  private readonly contextDir: string;
  private readonly modulesDir: string;
  private readonly packageDir: string;
  private readonly byKey: Map<string, GraphNode>;
  /** Absolute nested/sibling link path -> exact expected target text. */
  private readonly expectedLinks: SlotMap = new Map();
  /** Manifest path (posix, relative) -> entry. */
  private readonly manifestByPath = new Map<string, ManifestEntry>();
  /** Relative posix dirs allowed without a manifest listing (ancestors). */
  private readonly allowedDirs = new Set<string>([""]);

  constructor(
    store: Store,
    graph: GraphDoc,
    node: GraphNode,
    contextId: string,
  ) {
    this.store = store;
    this.graph = graph;
    this.node = node;
    this.contextId = contextId;
    this.contextDir = realizationDirFor(store, contextId);
    this.modulesDir = path.join(this.contextDir, "node_modules");
    this.packageDir = packageDirIn(this.contextDir, node.name);
    this.byKey = new Map(
      graph.nodes.map((candidate) => [candidate.key, candidate]),
    );
  }

  async run(): Promise<void> {
    await this.checkRealDir(this.contextDir, "context directory");
    const top = await this.readDir(this.contextDir, "context directory");
    if (top.length !== 1 || top[0] !== "node_modules") {
      throw this.corrupt("unexpected entries in context directory", {
        entries: top,
      });
    }
    await this.checkRealDir(this.packageDir, "package directory");
    const manifest = await this.readManifest();
    for (const entry of manifest) this.manifestByPath.set(entry.path, entry);
    this.planLinks();
    await this.checkManifestEntries();
    await this.checkLinkSlots();
    await this.checkNoExtras();
  }

  private corrupt(
    reason: string,
    detail: Record<string, unknown> = {},
  ): NexuError {
    return new NexuError(
      "NEXU_STORE_CORRUPT",
      `stored realization failed verification: ${reason}`,
      {
        detail: {
          context: this.contextId,
          node: this.node.key,
          path: this.contextDir,
          ...detail,
        },
        remedy:
          "remove the reported realization directory and reinstall the affected projects; do not edit shared realizations in place",
      },
    );
  }

  private async checkRealDir(dir: string, what: string): Promise<void> {
    let stat;
    try {
      stat = await lstat(dir);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw this.corrupt(`${what} is missing`, { dir });
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw this.corrupt(`${what} is not a real directory`, { dir });
    }
  }

  private async readDir(dir: string, what: string): Promise<string[]> {
    try {
      return [...(await readdir(dir))].sort();
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw this.corrupt(`${what} is missing`, { dir });
      throw error;
    }
  }

  private async readManifest(): Promise<ManifestEntry[]> {
    let doc;
    try {
      doc = await readSourceManifest(this.store, this.node.sourceId);
    } catch (error) {
      throw this.corrupt("source manifest is missing or invalid", {
        sourceId: this.node.sourceId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const manifest = doc.manifest;
    if (
      manifest.name !== this.node.name ||
      manifest.version !== this.node.version
    ) {
      throw this.corrupt("source identity does not match the recorded node", {
        expected: this.node.key,
        found: `${manifest.name}@${manifest.version}`,
      });
    }
    return manifest.entries;
  }

  /**
   * Replicate the link planner exactly: sibling slots at the context's
   * node_modules, nested slots under the package when the name collides
   * with the package itself or an earlier edge (SPEC 10.1.1).
   */
  private planLinks(): void {
    const siblingNames = new Set<string>([this.node.name]);
    for (const edge of this.node.edges) {
      const dependency = this.byKey.get(edge.target);
      if (dependency === undefined)
        throw internal(`edge ${edge.name} has no resolved node`);
      const targetText = packageDirIn(
        realizationDirFor(this.store, contextIdFor(this.graph, edge.target)),
        dependency.name,
      );
      const linkPath = siblingNames.has(edge.name)
        ? path.join(this.packageDir, "node_modules", ...edge.name.split("/"))
        : path.join(this.modulesDir, ...edge.name.split("/"));
      if (this.expectedLinks.has(linkPath))
        throw internal(`duplicate link slot for ${edge.name}`);
      this.expectedLinks.set(linkPath, targetText);
      siblingNames.add(edge.name);
    }
  }

  private async checkManifestEntries(): Promise<void> {
    for (const entry of this.manifestByPath.values()) {
      const full = path.join(this.packageDir, ...entry.path.split("/"));
      if (this.expectedLinks.has(full)) {
        throw this.corrupt("bundled content collides with a dependency slot", {
          path: entry.path,
        });
      }
      let stat;
      try {
        stat = await lstat(full);
      } catch (error) {
        if (isErrno(error, "ENOENT"))
          throw this.corrupt("manifest file is missing", { path: entry.path });
        throw error;
      }
      switch (entry.type) {
        case "dir":
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw this.corrupt("manifest directory is not a real directory", {
              path: entry.path,
            });
          }
          break;
        case "file": {
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw this.corrupt("manifest file is not a regular file", {
              path: entry.path,
            });
          }
          if (stat.size !== entry.size) {
            throw this.corrupt("manifest file size changed", {
              path: entry.path,
              expected: entry.size,
              found: stat.size,
            });
          }
          if (modeClassOf(stat.mode) !== entry.mode) {
            throw this.corrupt("manifest file mode class changed", {
              path: entry.path,
              expected: entry.mode,
            });
          }
          const digest = await sha512HexOfFile(full);
          if (digest !== entry.innerDigest) {
            throw this.corrupt("manifest file content changed", {
              path: entry.path,
            });
          }
          break;
        }
        case "symlink": {
          if (!stat.isSymbolicLink()) {
            throw this.corrupt("manifest symlink is not a link", {
              path: entry.path,
            });
          }
          const target = await readlink(full);
          if (target !== entry.target) {
            throw this.corrupt("manifest symlink target changed", {
              path: entry.path,
            });
          }
          break;
        }
      }
    }
  }

  private async checkLinkSlots(): Promise<void> {
    for (const [linkPath, expected] of this.expectedLinks) {
      let stat;
      try {
        stat = await lstat(linkPath);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          throw this.corrupt("dependency link is missing", { link: linkPath });
        }
        throw error;
      }
      if (!stat.isSymbolicLink()) {
        throw this.corrupt("dependency slot is not a link", { link: linkPath });
      }
      const target = await readlink(linkPath);
      if (target !== expected) {
        throw this.corrupt("dependency link target changed", {
          link: linkPath,
        });
      }
    }
  }

  private async checkNoExtras(): Promise<void> {
    for (const entry of this.manifestByPath.keys()) {
      this.allowAncestors(entry);
    }
    for (const linkPath of this.expectedLinks.keys()) {
      this.allowAncestors(
        path.relative(this.packageDir, linkPath).split(path.sep).join("/"),
      );
    }
    await this.walkPackageDir(this.packageDir, "");
    const top = await this.readDir(this.modulesDir, "node_modules directory");
    const expectedTop = new Set<string>();
    expectedTop.add(this.node.name.split("/")[0] ?? "");
    for (const edge of this.node.edges) {
      const first = edge.name.split("/")[0] ?? "";
      if (!this.isNested(edge.name)) expectedTop.add(first);
    }
    for (const name of top) {
      if (!expectedTop.has(name)) {
        throw this.corrupt("unexpected entry in node_modules directory", {
          entry: name,
        });
      }
    }
    const selfTop = this.node.name.split("/")[0] ?? "";
    for (const edge of this.node.edges) {
      if (this.isNested(edge.name)) continue;
      const segments = edge.name.split("/");
      if (segments.length === 2 && segments[0] !== selfTop) {
        await this.checkScopeDir(segments[0] ?? "");
      }
    }
    if (selfTop.startsWith("@")) await this.checkScopeDir(selfTop);
  }

  /** True when the edge routes to a nested slot under the package. */
  private isNested(edgeName: string): boolean {
    const siblingNames = new Set<string>([this.node.name]);
    for (const edge of this.node.edges) {
      if (edge.name === edgeName) return siblingNames.has(edge.name);
      siblingNames.add(edge.name);
    }
    throw internal(`unknown edge ${edgeName}`);
  }

  private async checkScopeDir(scope: string): Promise<void> {
    const dir = path.join(this.modulesDir, scope);
    let stat;
    try {
      stat = await lstat(dir);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw this.corrupt("scoped directory is missing", { scope });
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw this.corrupt("scoped directory is not a real directory", { scope });
    }
    const expected = new Set<string>();
    const pushChild = (name: string): void => {
      const segments = name.split("/");
      if (segments[0] === scope && segments[1] !== undefined)
        expected.add(segments[1]);
    };
    pushChild(this.node.name);
    for (const edge of this.node.edges) {
      if (!this.isNested(edge.name)) pushChild(edge.name);
    }
    const actual = await this.readDir(dir, "scoped directory");
    for (const name of actual) {
      if (!expected.has(name)) {
        throw this.corrupt("unexpected entry in scoped directory", {
          scope,
          entry: name,
        });
      }
    }
    for (const name of expected) {
      if (!actual.includes(name))
        throw this.corrupt("scoped entry is missing", { scope, entry: name });
    }
  }

  private allowAncestors(relative: string): void {
    const segments = relative.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      this.allowedDirs.add(segments.slice(0, depth).join("/"));
    }
  }

  private async walkPackageDir(dir: string, relative: string): Promise<void> {
    for (const name of await this.readDir(dir, "package directory")) {
      const rel = relative === "" ? name : `${relative}/${name}`;
      const full = path.join(dir, name);
      const stat = await lstat(full);
      if (this.expectedLinks.has(full)) continue;
      if (stat.isSymbolicLink()) {
        if (!this.manifestByPath.has(rel)) {
          throw this.corrupt("unexpected symlink in package directory", {
            path: rel,
          });
        }
        continue;
      }
      if (stat.isDirectory()) {
        const entry = this.manifestByPath.get(rel);
        if (entry !== undefined && entry.type !== "dir") {
          throw this.corrupt("package entry changed type", { path: rel });
        }
        if (entry === undefined && !this.allowedDirs.has(rel)) {
          throw this.corrupt("unexpected directory in package directory", {
            path: rel,
          });
        }
        await this.walkPackageDir(full, rel);
        continue;
      }
      if (stat.isFile()) {
        if (!this.manifestByPath.has(rel)) {
          throw this.corrupt("unexpected file in package directory", {
            path: rel,
          });
        }
        continue;
      }
      throw this.corrupt("unsupported entry type in package directory", {
        path: rel,
      });
    }
  }
}

function internal(message: string): NexuError {
  return new NexuError("NEXU_INTERNAL", message);
}
