import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTarball } from "../src/extract/tarball.ts";
import { installProjection, recoverProjection } from "../src/project/projection.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import { contextIdFor, createGraphDoc, nodeKeyOf, type GraphDoc } from "../src/store/graph.ts";
import { Store } from "../src/store/layout.ts";
import { packageDirIn, realizationDirFor, realizeGraph } from "../src/store/realize.ts";
import { commitExtractedSource } from "../src/store/source.ts";
import { craftTar, type CraftEntry } from "./helpers/tar.ts";

/**
 * P-001 evidence: the shared realization layout runs under ordinary Node.
 * Fixture packages are committed through the real extraction and commit
 * pipeline, then executed with plain `node app.cjs` / `node app.mjs` against a
 * projection. Every SNPM_* variable, NODE_PATH, and NODE_OPTIONS is stripped
 * from the child environment: the layout must need no loader and no help.
 */

const ORIGIN = "https://registry.npmjs.org";

let root: string;
let store: Store;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "snpm-runtime-"));
  store = await Store.open({ root: path.join(root, "store"), create: true });
});

afterEach(async () => {
  await rmrfNoFollow(root);
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected value to be defined");
  return value;
}

async function commitPackage(options: {
  name: string;
  version: string;
  files: Array<{ path: string; data: string; mode?: number }>;
}): Promise<string> {
  counter += 1;
  const { name, version, files } = options;
  const staging = path.join(root, "fetch", `pkg-${counter}`);
  await mkdir(staging, { recursive: true });
  const tarballPath = path.join(staging, "archive.tgz");
  const entries: CraftEntry[] = [
    { path: "package", type: "dir" },
    ...files.map(
      (file): CraftEntry => ({
        path: `package/${file.path}`,
        data: file.data,
        mode: file.mode ?? 0o644,
      }),
    ),
  ];
  await writeFile(tarballPath, craftTar(entries));
  const extraction = await extractTarball({ tarballPath, destDir: path.join(staging, "extract") });
  const committed = await commitExtractedSource({
    store,
    extraction,
    name,
    version,
    origin: ORIGIN,
    integrity: `sha512-${Buffer.from(`${name}@${version}`).toString("base64")}`,
    archiveBytes: 1024,
  });
  return committed.sourceId;
}

function runNode(cwd: string, file: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SNPM_") && key !== "NODE_PATH" && key !== "NODE_OPTIONS",
    ),
  ) as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file], { cwd, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`node ${file} failed: ${error.message}\nstderr:\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function packageJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fixtureSources(): Promise<{ alpha: string; beta: string; gamma: string }> {
  const beta = await commitPackage({
    name: "beta",
    version: "1.0.0",
    files: [
      {
        path: "package.json",
        data: packageJson({
          name: "beta",
          version: "1.0.0",
          exports: { ".": { require: "./index.cjs", import: "./index.mjs" } },
        }),
      },
      { path: "index.cjs", data: 'module.exports = { flavor: "beta-cjs" };\n' },
      { path: "index.mjs", data: 'export default "beta-esm";\n' },
      { path: "cli.js", data: '#!/usr/bin/env node\nconsole.log("beta-cli");\n', mode: 0o755 },
    ],
  });
  const alpha = await commitPackage({
    name: "alpha",
    version: "1.0.0",
    files: [
      { path: "package.json", data: packageJson({ name: "alpha", version: "1.0.0", main: "index.js" }) },
      { path: "index.js", data: 'module.exports = "alpha+" + require("beta").flavor;\n' },
      { path: "sub.js", data: 'module.exports = require("./index.js") + "+sub";\n' },
    ],
  });
  const gamma = await commitPackage({
    name: "@scope/gamma",
    version: "2.0.0",
    files: [
      {
        path: "package.json",
        data: packageJson({ name: "@scope/gamma", version: "2.0.0", type: "module", exports: "./index.js" }),
      },
      { path: "index.js", data: 'import beta from "beta";\nexport default "gamma+" + beta;\n' },
    ],
  });
  return { alpha, beta, gamma };
}

function fixtureGraph(sources: { alpha: string; beta: string; gamma: string }): GraphDoc {
  return createGraphDoc([
    {
      name: "alpha",
      version: "1.0.0",
      sourceId: sources.alpha,
      deps: [{ name: "beta", target: nodeKeyOf("beta", "1.0.0") }],
    },
    { name: "beta", version: "1.0.0", sourceId: sources.beta },
    {
      name: "@scope/gamma",
      version: "2.0.0",
      sourceId: sources.gamma,
      deps: [{ name: "beta", target: nodeKeyOf("beta", "1.0.0") }],
    },
  ]);
}

describe("shared realizations", () => {
  it("materializes real directories with sibling dependency links into their own contexts", async () => {
    const sources = await fixtureSources();
    const graph = fixtureGraph(sources);
    const realized = await realizeGraph({ store, graph });

    expect(realized.created.length).toBe(3);
    expect(realized.reused).toEqual([]);

    const alphaDir = must(realized.packageDirByKey.get(nodeKeyOf("alpha", "1.0.0")));
    const betaDir = must(realized.packageDirByKey.get(nodeKeyOf("beta", "1.0.0")));
    const gammaDir = must(realized.packageDirByKey.get(nodeKeyOf("@scope/gamma", "2.0.0")));
    const alphaContext = realizationDirFor(store, contextIdFor(graph, nodeKeyOf("alpha", "1.0.0")));
    const gammaContext = realizationDirFor(store, contextIdFor(graph, nodeKeyOf("@scope/gamma", "2.0.0")));

    // The package directory is real, never a symlink to a context-free tree.
    expect((await lstat(alphaDir)).isSymbolicLink()).toBe(false);
    expect((await lstat(alphaDir)).isDirectory()).toBe(true);
    expect(alphaDir).toBe(packageDirIn(alphaContext, "alpha"));
    expect(gammaDir).toBe(packageDirIn(gammaContext, "@scope/gamma"));
    expect((await lstat(gammaDir)).isSymbolicLink()).toBe(false);

    // Different roots get distinct contexts; the edge is a sibling link into
    // the dependency's own realization (I-008).
    expect(contextIdFor(graph, nodeKeyOf("alpha", "1.0.0"))).not.toBe(
      contextIdFor(graph, nodeKeyOf("beta", "1.0.0")),
    );
    const betaLink = path.join(alphaContext, "node_modules", "beta");
    expect((await lstat(betaLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(betaLink)).toBe(betaDir);

    // Committed shared source stays read-only; executable bits survive.
    expect((await stat(alphaDir)).mode & 0o222).toBe(0);
    expect((await stat(alphaContext)).mode & 0o222).toBe(0);
    expect((await stat(path.join(betaDir, "cli.js"))).mode & 0o111).not.toBe(0);
    expect((await stat(path.join(betaDir, "index.cjs"))).mode & 0o111).toBe(0);

    // Identical inputs reuse the published realization without rebuilding.
    const again = await realizeGraph({ store, graph });
    expect(again.created).toEqual([]);
    expect(again.reused.length).toBe(3);
  });

  it("runs ordinary CJS and ESM entry points from two projects sharing one realization", async () => {
    const sources = await fixtureSources();
    const graph = fixtureGraph(sources);
    const realized = await realizeGraph({ store, graph });
    const alphaDir = must(realized.packageDirByKey.get(nodeKeyOf("alpha", "1.0.0")));
    const gammaDir = must(realized.packageDirByKey.get(nodeKeyOf("@scope/gamma", "2.0.0")));
    const entries = [
      { name: "alpha", linkTarget: alphaDir },
      { name: "@scope/gamma", linkTarget: gammaDir },
    ];

    const projectA = path.join(root, "app-a");
    await mkdir(projectA, { recursive: true });
    const resultA = await installProjection(projectA, entries);
    await writeFile(
      path.join(projectA, "app.cjs"),
      'const alpha = require("alpha");\nconst sub = require("alpha/sub.js");\nconsole.log(alpha);\nconsole.log(sub);\n',
    );
    await writeFile(
      path.join(projectA, "app.mjs"),
      'import alpha from "alpha";\nimport gamma from "@scope/gamma";\nconsole.log(alpha);\nconsole.log(gamma);\n',
    );

    expect(await runNode(projectA, "app.cjs")).toBe("alpha+beta-cjs\nalpha+beta-cjs+sub\n");
    expect(await runNode(projectA, "app.mjs")).toBe("alpha+beta-cjs\ngamma+beta-esm\n");

    // The projection exposes links, never copies (SPEC 10.3).
    const alphaLink = path.join(projectA, "node_modules", "alpha");
    expect((await lstat(alphaLink)).isSymbolicLink()).toBe(true);
    expect(await realpath(alphaLink)).toBe(await realpath(alphaDir));
    expect((await lstat(path.join(projectA, "node_modules", "@scope", "gamma"))).isSymbolicLink()).toBe(true);

    const state = JSON.parse(
      await readFile(path.join(projectA, "node_modules", ".snpm", "install-state.json"), "utf8"),
    ) as { generationId: string; linker: string; readiness: string; direct: Array<{ name: string }> };
    expect(state.generationId).toBe(resultA.generationId);
    expect(state.linker).toBe("shared");
    expect(state.readiness).toBe("ready");
    expect(state.direct.map((entry) => entry.name)).toEqual(["alpha", "@scope/gamma"]);

    // A second project shares the same realization; no rebuild, no copy.
    const projectB = path.join(root, "app-b");
    await mkdir(projectB, { recursive: true });
    const resultB = await installProjection(projectB, entries);
    expect(resultB.generationId).not.toBe(resultA.generationId);
    expect(await realpath(path.join(projectB, "node_modules", "alpha"))).toBe(await realpath(alphaLink));
    await writeFile(path.join(projectB, "app.cjs"), 'console.log(require("alpha"));\n');
    expect(await runNode(projectB, "app.cjs")).toBe("alpha+beta-cjs\n");
  });

  it("replaces a projection in place without leaving staging or previous generations", async () => {
    const sources = await fixtureSources();
    const graph = fixtureGraph(sources);
    const realized = await realizeGraph({ store, graph });
    const alphaDir = must(realized.packageDirByKey.get(nodeKeyOf("alpha", "1.0.0")));
    const gammaDir = must(realized.packageDirByKey.get(nodeKeyOf("@scope/gamma", "2.0.0")));

    const project = path.join(root, "swap-project");
    await mkdir(project, { recursive: true });
    const first = await installProjection(project, [
      { name: "alpha", linkTarget: alphaDir },
      { name: "@scope/gamma", linkTarget: gammaDir },
    ]);
    const second = await installProjection(project, [{ name: "alpha", linkTarget: alphaDir }]);

    expect(second.generationId).not.toBe(first.generationId);
    expect(await pathExists(path.join(project, "node_modules", "@scope"))).toBe(false);
    const leftovers = (await readdir(project)).filter((name) => name.startsWith("node_modules.snpm-"));
    expect(leftovers).toEqual([]);

    await writeFile(path.join(project, "app.cjs"), 'console.log(require("alpha"));\n');
    expect(await runNode(project, "app.cjs")).toBe("alpha+beta-cjs\n");
  });
});

describe("projection recovery", () => {
  it("restores the previous complete projection after an interrupted swap", async () => {
    const project = path.join(root, "crash-project");
    const oldDir = path.join(project, "node_modules.snpm-old-gen1_crash");
    await mkdir(oldDir, { recursive: true });
    await writeFile(path.join(oldDir, "marker.txt"), "old-complete\n");
    await mkdir(path.join(project, "node_modules.snpm-staging-gen1_crash"), { recursive: true });
    await mkdir(path.join(project, ".snpm-local"), { recursive: true });
    await writeFile(
      path.join(project, ".snpm-local", "journal.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), event: "old-moved", generationId: "gen1_crash" })}\n`,
    );

    await recoverProjection(project);

    expect(await readFile(path.join(project, "node_modules", "marker.txt"), "utf8")).toBe("old-complete\n");
    await expect(lstat(path.join(project, "node_modules.snpm-staging-gen1_crash"))).rejects.toThrow();
    await expect(lstat(path.join(project, "node_modules.snpm-old-gen1_crash"))).rejects.toThrow();
    await expect(lstat(path.join(project, ".snpm-local", "journal.jsonl"))).rejects.toThrow();
  });

  it("removes staging but keeps a stray previous generation that has no journal", async () => {
    const project = path.join(root, "noisy-project");
    await mkdir(path.join(project, "node_modules"), { recursive: true });
    await writeFile(path.join(project, "node_modules", "marker.txt"), "live\n");
    const stray = path.join(project, "node_modules.snpm-old-gen1_stray");
    await mkdir(stray, { recursive: true });
    await mkdir(path.join(project, "node_modules.snpm-staging-gen1_stray"), { recursive: true });

    await recoverProjection(project);

    expect(await readFile(path.join(project, "node_modules", "marker.txt"), "utf8")).toBe("live\n");
    expect((await lstat(stray)).isDirectory()).toBe(true);
    await expect(lstat(path.join(project, "node_modules.snpm-staging-gen1_stray"))).rejects.toThrow();
  });
});

describe("dependency slot collisions", () => {
  it("uses a nested slot when a dependency shares the package's own name (A-014)", async () => {
    const alpha2 = await commitPackage({
      name: "alpha",
      version: "2.0.0",
      files: [
        { path: "package.json", data: packageJson({ name: "alpha", version: "2.0.0", main: "index.js" }) },
        { path: "index.js", data: 'module.exports = { value: "alpha2" };\n' },
      ],
    });
    const alpha1 = await commitPackage({
      name: "alpha",
      version: "1.0.0",
      files: [
        { path: "package.json", data: packageJson({ name: "alpha", version: "1.0.0", main: "index.js" }) },
        { path: "index.js", data: 'module.exports = "alpha1+" + require("alpha").value + "+" + require("alt").value;\n' },
      ],
    });

    const graph = createGraphDoc([
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: alpha1,
        deps: [
          { name: "alpha", target: nodeKeyOf("alpha", "2.0.0") },
          { name: "alt", target: nodeKeyOf("alpha", "2.0.0") },
        ],
      },
      { name: "alpha", version: "2.0.0", sourceId: alpha2 },
    ]);
    const realized = await realizeGraph({ store, graph });
    const alpha1Dir = must(realized.packageDirByKey.get(nodeKeyOf("alpha", "1.0.0")));
    const alpha2Dir = must(realized.packageDirByKey.get(nodeKeyOf("alpha", "2.0.0")));
    const context1 = realizationDirFor(store, contextIdFor(graph, nodeKeyOf("alpha", "1.0.0")));

    // The sibling slot holds alpha@1 itself; alpha@2 is reachable through the
    // nested slot and through the free alias slot.
    expect(alpha1Dir).toBe(path.join(context1, "node_modules", "alpha"));
    const nested = path.join(alpha1Dir, "node_modules", "alpha");
    expect((await lstat(nested)).isSymbolicLink()).toBe(true);
    expect(await readlink(nested)).toBe(alpha2Dir);
    const aliasSlot = path.join(context1, "node_modules", "alt");
    expect((await lstat(aliasSlot)).isSymbolicLink()).toBe(true);
    expect(await readlink(aliasSlot)).toBe(alpha2Dir);

    // Real Node: requiring "alpha" inside alpha@1 finds the nested alpha@2
    // before the sibling slot; the alias resolves through the sibling slot.
    const project = path.join(root, "nested-project");
    await mkdir(project, { recursive: true });
    await installProjection(project, [
      { name: "alpha", linkTarget: alpha1Dir },
      { name: "alt", linkTarget: alpha2Dir },
    ]);
    await writeFile(path.join(project, "app.cjs"), 'console.log(require("alpha"));\n');
    expect(await runNode(project, "app.cjs")).toBe("alpha1+alpha2+alpha2\n");
  });
});
