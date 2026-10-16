import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTarball } from "../src/extract/tarball.ts";
import { installProjection } from "../src/project/projection.ts";
import {
  contextIdFor,
  createGraphDoc,
  type GraphDoc,
} from "../src/store/graph.ts";
import { Store } from "../src/store/layout.ts";
import {
  packageDirIn,
  realizationDirFor,
  realizeGraph,
} from "../src/store/realize.ts";
import { commitExtractedSource } from "../src/store/source.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import { craftTar, type CraftEntry } from "./helpers/tar.ts";

/**
 * S01 evidence: an existing realization is never trusted by existence
 * alone. Every corruption below must fail with NEXU_STORE_CORRUPT before
 * anything executes, without changing unrelated projects.
 */

const ORIGIN = "https://registry.npmjs.org";

let root: string;
let store: Store;
let counter = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nexu-verify-"));
  store = await Store.open({ root: path.join(root, "store"), create: true });
});

afterEach(async () => {
  await rmrfNoFollow(root);
});

async function commitPackage(options: {
  name: string;
  version: string;
  files: Array<{ path: string; data: string; mode?: number }>;
}): Promise<string> {
  counter += 1;
  const staging = path.join(root, "fetch", `pkg-${counter}`);
  await mkdir(staging, { recursive: true });
  const tarballPath = path.join(staging, "archive.tgz");
  const entries: CraftEntry[] = [
    { path: "package", type: "dir" },
    ...options.files.map((file): CraftEntry => ({
      path: `package/${file.path}`,
      data: file.data,
      mode: file.mode ?? 0o644,
    })),
  ];
  await writeFile(tarballPath, craftTar(entries));
  const extraction = await extractTarball({
    tarballPath,
    destDir: path.join(staging, "extract"),
  });
  const committed = await commitExtractedSource({
    store,
    extraction,
    name: options.name,
    version: options.version,
    origin: ORIGIN,
    integrity: `sha512-${Buffer.from(`${options.name}@${options.version}`).toString("base64")}`,
    archiveBytes: 1024,
  });
  return committed.sourceId;
}

function packageJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fixtureGraph(): Promise<{
  graph: GraphDoc;
  libSource: string;
  toolSource: string;
}> {
  const libSource = await commitPackage({
    name: "lib",
    version: "2.0.0",
    files: [
      {
        path: "package.json",
        data: packageJson({ name: "lib", version: "2.0.0", main: "index.js" }),
      },
      { path: "index.js", data: 'module.exports = "lib-ok";\n' },
    ],
  });
  const toolSource = await commitPackage({
    name: "tool",
    version: "1.0.0",
    files: [
      {
        path: "package.json",
        data: packageJson({ name: "tool", version: "1.0.0", main: "index.js" }),
      },
      {
        path: "index.js",
        data: 'module.exports = "tool+" + require("lib");\n',
      },
    ],
  });
  const graph = createGraphDoc([
    {
      name: "tool",
      version: "1.0.0",
      sourceId: toolSource,
      deps: [{ name: "lib", target: "lib@2.0.0" }],
    },
    { name: "lib", version: "2.0.0", sourceId: libSource },
  ]);
  return { graph, libSource, toolSource };
}

/** Make a committed path writable, run the callback, then restore its mode. */
async function asWritable(
  target: string,
  mode: number,
  task: () => Promise<void>,
): Promise<void> {
  await chmod(target, mode);
  try {
    await task();
  } finally {
    await chmod(target, mode === 0o444 ? 0o444 : 0o555);
  }
}

function runNode(
  cwd: string,
  file: string,
): Promise<{ code: number; stdout: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("NEXU_") &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS",
    ),
  ) as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file], { cwd, env }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") resolve({ code, stdout });
        else reject(error);
      } else {
        resolve({ code: 0, stdout });
      }
    });
  });
}

describe("realization reuse verification (S01)", () => {
  it("reuses a healthy realization without complaint", async () => {
    const { graph } = await fixtureGraph();
    const first = await realizeGraph({ store, graph });
    expect(first.created.length).toBe(2);
    const second = await realizeGraph({ store, graph });
    expect(second.created).toEqual([]);
    expect(second.reused.length).toBe(2);
  });

  it("rejects same-size content corruption before anything executes", async () => {
    const { graph } = await fixtureGraph();
    await realizeGraph({ store, graph });
    const libDir = packageDirIn(
      realizationDirFor(store, contextIdFor(graph, "lib@2.0.0")),
      "lib",
    );
    const indexFile = path.join(libDir, "index.js");
    const original = await readFile(indexFile, "utf8");
    const modified = original.replace("ok", "XX");
    expect(modified.length).toBe(original.length);
    expect(modified).not.toBe(original);
    await asWritable(indexFile, 0o644, async () => {
      await writeFile(indexFile, modified);
    });

    const failure = await realizeGraph({ store, graph }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NEXU_STORE_CORRUPT" });
    expect(failure).toMatchObject({
      detail: expect.objectContaining({ node: "lib@2.0.0" }),
    });
    // The corruption is reported, not repaired in place: bytes stay damaged.
    expect(await readFile(indexFile, "utf8")).toBe(modified);
  });

  it("rejects a missing manifest file", async () => {
    const { graph } = await fixtureGraph();
    await realizeGraph({ store, graph });
    const toolDir = packageDirIn(
      realizationDirFor(store, contextIdFor(graph, "tool@1.0.0")),
      "tool",
    );
    await asWritable(toolDir, 0o755, async () => {
      await unlink(path.join(toolDir, "index.js"));
    });
    await expect(realizeGraph({ store, graph })).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });

  it("rejects extra files inside the package directory", async () => {
    const { graph } = await fixtureGraph();
    await realizeGraph({ store, graph });
    const libDir = packageDirIn(
      realizationDirFor(store, contextIdFor(graph, "lib@2.0.0")),
      "lib",
    );
    await asWritable(libDir, 0o755, async () => {
      await writeFile(path.join(libDir, "evil.js"), "x\n");
    });
    await expect(realizeGraph({ store, graph })).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });

  it("rejects extra entries at the node_modules level", async () => {
    const { graph } = await fixtureGraph();
    await realizeGraph({ store, graph });
    const modulesDir = path.join(
      realizationDirFor(store, contextIdFor(graph, "lib@2.0.0")),
      "node_modules",
    );
    await asWritable(modulesDir, 0o755, async () => {
      await writeFile(path.join(modulesDir, "stowaway"), "x\n");
    });
    await expect(realizeGraph({ store, graph })).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });
  });

  it("rejects a retargeted dependency link", async () => {
    const { graph } = await fixtureGraph();
    const realized = await realizeGraph({ store, graph });
    const toolContext = realizationDirFor(
      store,
      contextIdFor(graph, "tool@1.0.0"),
    );
    const link = path.join(toolContext, "node_modules", "lib");
    const before = await readlink(link);
    const toolDir = realized.packageDirByKey.get("tool@1.0.0");
    if (toolDir === undefined) throw new Error("expected tool package dir");
    await asWritable(
      path.join(toolContext, "node_modules"),
      0o755,
      async () => {
        await unlink(link);
        await symlink(toolDir, link);
      },
    );
    expect(await readlink(link)).not.toBe(before);
    const failure = await realizeGraph({ store, graph }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NEXU_STORE_CORRUPT" });
    expect(failure).toMatchObject({
      detail: expect.objectContaining({ node: "tool@1.0.0" }),
    });
  });

  it("rejects a corrupted transitive child when re-realizing the parents", async () => {
    const { graph } = await fixtureGraph();
    await realizeGraph({ store, graph });
    const libDir = packageDirIn(
      realizationDirFor(store, contextIdFor(graph, "lib@2.0.0")),
      "lib",
    );
    const indexFile = path.join(libDir, "index.js");
    const original = await readFile(indexFile, "utf8");
    await asWritable(indexFile, 0o644, async () => {
      await writeFile(indexFile, `${original}// damaged\n`);
    });
    const failure = await realizeGraph({ store, graph }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NEXU_STORE_CORRUPT" });
    expect(failure).toMatchObject({
      detail: expect.objectContaining({ node: "lib@2.0.0" }),
    });
  });

  it("leaves unrelated projects runnable after a failed reuse", async () => {
    const { graph } = await fixtureGraph();
    const realized = await realizeGraph({ store, graph });
    const toolDir = realized.packageDirByKey.get("tool@1.0.0");
    if (toolDir === undefined) throw new Error("expected tool package dir");
    const project = path.join(root, "app");
    await mkdir(project, { recursive: true });
    await installProjection(project, [{ name: "tool", linkTarget: toolDir }]);
    await writeFile(
      path.join(project, "app.cjs"),
      'console.log(require("tool"));\n',
    );
    const alphaLink = path.join(project, "node_modules", "tool");
    const linkBefore = await readlink(alphaLink);
    expect((await runNode(project, "app.cjs")).code).toBe(0);

    const libDir = packageDirIn(
      realizationDirFor(store, contextIdFor(graph, "lib@2.0.0")),
      "lib",
    );
    await asWritable(path.join(libDir, "index.js"), 0o644, async () => {
      await writeFile(
        path.join(libDir, "index.js"),
        'module.exports = "damaged";\n',
      );
    });
    await expect(realizeGraph({ store, graph })).rejects.toMatchObject({
      code: "NEXU_STORE_CORRUPT",
    });

    expect(await readlink(alphaLink)).toBe(linkBefore);
    expect(await realpath(alphaLink)).toBe(await realpath(toolDir));
    expect((await runNode(project, "app.cjs")).code).toBe(0);
  });

  it("survives concurrent publishers without corruption", async () => {
    const { graph } = await fixtureGraph();
    const attempts = await Promise.all(
      [0, 1, 2, 3].map(() =>
        realizeGraph({ store, graph }).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ),
    );
    for (const attempt of attempts) {
      expect(attempt.ok).toBe(true);
    }
    const again = await realizeGraph({ store, graph });
    expect(again.created).toEqual([]);
    expect(again.reused.length).toBe(2);
    expect(await readdir(path.join(root, "store", "staging"))).toEqual([]);
  });
});
