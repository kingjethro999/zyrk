import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installWorkspaceProject } from "../src/install/workspace-install.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
const exec = promisify(execFile);
let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-ws-install-"));
  project = path.join(root, "app");
  await mkdir(path.join(project, "packages", "a"), { recursive: true });
  await mkdir(path.join(project, "packages", "b"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { a: "workspace:*", pure: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/a/package.json"),
    JSON.stringify({
      name: "a",
      version: "1.0.0",
      dependencies: { b: "workspace:*", plugin: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/b/package.json"),
    JSON.stringify({ name: "b", version: "1.0.0" }),
  );
  await writeFile(
    path.join(project, "packages/a/index.js"),
    'module.exports=[require("b"),require("plugin")];',
  );
  await writeFile(
    path.join(project, "packages/b/index.js"),
    "module.exports={value:1};",
  );
  server = await startStubRegistry([
    {
      name: "pure",
      versions: [
        {
          version: "2.0.0",
          files: { "index.js": { data: "module.exports=84;" } },
        },
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports=42;" } },
        },
      ],
    },
    {
      name: "plugin",
      versions: [
        {
          version: "2.0.0",
          peerDeps: { b: "*" },
          scripts: {
            postinstall: "node -e \"require('fs').writeFileSync('ran','bad')\"",
          },
          files: { "index.js": { data: 'module.exports=require("b");' } },
        },
        {
          version: "1.0.0",
          peerDeps: { b: "*" },
          files: { "index.js": { data: 'module.exports=require("b");' } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "zyrk-test",
    retries: 0,
  });
  store = await Store.open({ root: path.join(root, "store"), create: true });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
it("installs live CJS/ESM workspace packages with singleton peers and shared pure registry closures", async () => {
  const result = await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
  });
  expect(result.readiness).toBe("ready");
  const code =
    'const [a,b]=require("a");if(a!==b)throw Error("split peer");console.log(a.value,require("pure"));';
  expect(
    (
      await exec(process.execPath, ["-e", code], { cwd: project })
    ).stdout.trim(),
  ).toBe("1 42");
  expect(
    (await realpath(path.join(project, "node_modules/pure"))).startsWith(
      store.paths.realizationsDir,
    ),
  ).toBe(true);
  expect(
    (
      await realpath(path.join(project, "packages/a/node_modules/plugin"))
    ).startsWith(project),
  ).toBe(true);
  await writeFile(
    path.join(project, "packages/b/index.js"),
    "module.exports={value:2};",
  );
  expect(
    (
      await exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import a from "a";console.log(a[0].value)',
        ],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("2");
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8");
  expect(lock).not.toContain(project);
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    offline: true,
    frozen: true,
  });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
});
it("rejects a tampered local importer traversal before projection mutation", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const file = path.join(project, "package-lock.json"),
    lock = JSON.parse(await readFile(file, "utf8"));
  lock.zyrk.workspaceGraph.nodes.find(
    (n: { kind: string }) => n.kind === "local",
  ).importer = "../escape";
  await writeFile(file, JSON.stringify(lock));
  await expect(
    installWorkspaceProject({
      projectDir: project,
      store,
      registry,
      frozen: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
});

it("rolls every importer and the root lock back after an interrupted partial publication", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8");
  const { rename } = await import("node:fs/promises");
  const { recoverWorkspaceProjection, workspaceProjectionPaths } =
    await import("../src/install/workspace-transaction.ts");
  const generationId = "gen1_aaaa",
    ids = [".", "packages/a", "packages/b"];
  const p = workspaceProjectionPaths(project, ".", generationId);
  await rename(p.active, p.previous);
  await mkdir(p.active);
  await writeFile(path.join(p.active, "candidate"), "partial");
  await writeFile(path.join(project, "package-lock.json"), "{}");
  await writeFile(
    path.join(project, ".zyrk-local/workspace-journal.json"),
    JSON.stringify({
      version: 1,
      generationId,
      committed: false,
      lockBefore: lock,
      lockAfter: "{}",
      importers: ids.map((id) => ({ id, hadBefore: true })),
    }),
  );
  await recoverWorkspaceProjection(project);
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("a")[0].value)'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("1");
});
it("rejects journal traversal before writing a victim path", async () => {
  await mkdir(path.join(project, ".zyrk-local"));
  const { recoverWorkspaceProjection } =
    await import("../src/install/workspace-transaction.ts");
  await writeFile(
    path.join(project, ".zyrk-local/workspace-journal.json"),
    JSON.stringify({
      version: 1,
      generationId: "gen1_aaaa",
      committed: false,
      lockBefore: "victim",
      lockAfter: "{}",
      importers: [
        { id: ".", hadBefore: false },
        { id: "../victim", hadBefore: false },
      ],
    }),
  );
  const before = await readFile(path.join(project, "package.json"), "utf8");
  await expect(recoverWorkspaceProjection(project)).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  expect(await readFile(path.join(project, "package.json"), "utf8")).toBe(
    before,
  );
});
it("rejects unsupported live-source dependency builds before running any candidate script", async () => {
  const file = path.join(project, "packages/a/package.json"),
    manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.dependencies.plugin = "2.0.0";
  await writeFile(file, JSON.stringify(manifest));
  await expect(
    installWorkspaceProject({ projectDir: project, store, registry }),
  ).rejects.toMatchObject({ code: "ZYRK_WORKSPACE_BUILD_CONTEXT_UNSUPPORTED" });
});
it("adds and removes dependencies in the invoking importer while preserving unrelated selections", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const rootManifest = await readFile(
    path.join(project, "package.json"),
    "utf8",
  );
  const child = path.join(project, "packages/a");
  await installWorkspaceProject({
    projectDir: child,
    store,
    registry,
    specs: ["pure@1.0.0"],
    saveDev: true,
    saveExact: true,
  });
  expect(
    JSON.parse(await readFile(path.join(child, "package.json"), "utf8"))
      .devDependencies,
  ).toEqual({ pure: "1.0.0" });
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: child,
      })
    ).stdout.trim(),
  ).toBe("42");
  expect(await readFile(path.join(project, "package.json"), "utf8")).toBe(
    rootManifest,
  );
  await installWorkspaceProject({
    projectDir: child,
    store,
    registry,
    mutation: { remove: ["pure"] },
  });
  expect(
    JSON.parse(await readFile(path.join(child, "package.json"), "utf8"))
      .devDependencies,
  ).toEqual({});
  expect(await readFile(path.join(project, "package.json"), "utf8")).toBe(
    rootManifest,
  );
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    offline: true,
    frozen: true,
  });
});
it("reuses one private registry occurrence for identical live peer contexts across importers", async () => {
  const file = path.join(project, "package.json"),
    m = JSON.parse(await readFile(file, "utf8"));
  m.dependencies.plugin = "1.0.0";
  m.dependencies.b = "workspace:*";
  await writeFile(file, JSON.stringify(m));
  await installWorkspaceProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("plugin")===require("a")[1])'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("true");
  expect(await realpath(path.join(project, "node_modules/plugin"))).toBe(
    await realpath(path.join(project, "packages/a/node_modules/plugin")),
  );
});
it("commits lockfile-only importer edits without replacing active node_modules", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const before = await readFile(
    path.join(project, "node_modules/.zyrk/install-state.json"),
    "utf8",
  );
  await installWorkspaceProject({
    projectDir: path.join(project, "packages/a"),
    store,
    registry,
    specs: ["pure@1.0.0"],
    saveExact: true,
    lockfileOnly: true,
  });
  expect(
    JSON.parse(
      await readFile(path.join(project, "packages/a/package.json"), "utf8"),
    ).dependencies.pure,
  ).toBe("1.0.0");
  expect(
    await readFile(
      path.join(project, "node_modules/.zyrk/install-state.json"),
      "utf8",
    ),
  ).toBe(before);
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    offline: true,
    frozen: true,
  });
});
it("restores edited importer manifests with the old lock after interrupted publication", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8"),
    file = path.join(project, "packages/a/package.json"),
    before = await readFile(file, "utf8");
  const after = '{"name":"a","version":"1.0.0"}';
  await writeFile(file, after);
  await writeFile(
    path.join(project, ".zyrk-local/workspace-journal.json"),
    JSON.stringify({
      version: 1,
      generationId: "gen1_aaaa",
      committed: false,
      lockBefore: lock,
      lockAfter: "{}",
      importers: [".", "packages/a", "packages/b"].map((id) => ({
        id,
        hadBefore: true,
      })),
      manifests: [{ id: "packages/a", before, after }],
    }),
  );
  const { recoverWorkspaceProjection } =
    await import("../src/install/workspace-transaction.ts");
  await recoverWorkspaceProjection(project);
  expect(await readFile(file, "utf8")).toBe(before);
});
it("links a declared file workspace reference as live source", async () => {
  const file = path.join(project, "packages/a/package.json"),
    m = JSON.parse(await readFile(file, "utf8"));
  m.dependencies.b = "file:../b";
  await writeFile(file, JSON.stringify(m));
  await installWorkspaceProject({ projectDir: project, store, registry });
  expect(await realpath(path.join(project, "packages/a/node_modules/b"))).toBe(
    path.join(project, "packages/b"),
  );
});
it("updates the selected importer to latest without changing another importer version", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  await installWorkspaceProject({
    projectDir: path.join(project, "packages/a"),
    store,
    registry,
    specs: ["pure@1.0.0"],
    saveExact: true,
  });
  await installWorkspaceProject({
    projectDir: path.join(project, "packages/a"),
    store,
    registry,
    mutation: { update: ["pure"], latest: true },
    saveExact: true,
  });
  expect(
    JSON.parse(
      await readFile(path.join(project, "packages/a/package.json"), "utf8"),
    ).dependencies.pure,
  ).toBe("2.0.0");
  expect(
    JSON.parse(await readFile(path.join(project, "package.json"), "utf8"))
      .dependencies.pure,
  ).toBe("1.0.0");
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("42");
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: path.join(project, "packages/a"),
      })
    ).stdout.trim(),
  ).toBe("84");
});
it("repairs corrupt shared registry inputs into new immutable workspace instances", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const prior = await realpath(path.join(project, "node_modules/pure")),
    file = path.join(prior, "index.js");
  const { chmod } = await import("node:fs/promises");
  await chmod(file, 0o644);
  await writeFile(file, "module.exports=999;");
  await expect(
    installWorkspaceProject({ projectDir: project, store, registry }),
  ).rejects.toMatchObject({ code: "ZYRK_STORE_CORRUPT" });
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    repair: true,
  });
  expect(await realpath(path.join(project, "node_modules/pure"))).not.toBe(
    prior,
  );
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("42");
});
it("keeps explicit mutable registry packages private while workspace source stays live", async () => {
  const file = path.join(project, "package.json"),
    m = JSON.parse(await readFile(file, "utf8"));
  m.zyrk = { mutablePackages: ["pure"] };
  await writeFile(file, JSON.stringify(m));
  await installWorkspaceProject({ projectDir: project, store, registry });
  const target = await realpath(path.join(project, "node_modules/pure"));
  expect(target.startsWith(project)).toBe(true);
  const { openStoreDb } = await import("../src/store/db.ts"),
    db = openStoreDb(store.paths.dbFile);
  try {
    const sharedRows = db
      .prepare("SELECT context_id,path FROM realization_instances")
      .all() as Array<{ context_id: string; path: string }>;
    const sharedInputs = sharedRows.filter(
      (row) => path.dirname(row.path) === store.paths.realizationsDir,
    );
    expect(sharedInputs.length).toBeGreaterThan(0);
    for (const row of sharedInputs)
      expect(row.context_id).toBe(path.basename(row.path));
  } finally {
    db.close();
  }

  await writeFile(path.join(target, "index.js"), "module.exports=71;");
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("71");
  expect(await realpath(path.join(project, "node_modules/a"))).toBe(
    path.join(project, "packages/a"),
  );
});
it("lets pinned npm Arborist read the complete workspace registry and local graph without reification", async () => {
  for (const relative of ["package.json", "packages/a/package.json"]) {
    const file = path.join(project, relative),
      m = JSON.parse(await readFile(file, "utf8"));
    for (const name of Object.keys(m.dependencies))
      if (m.dependencies[name].startsWith("workspace:"))
        m.dependencies[name] = "*";
    await writeFile(file, JSON.stringify(m));
  }
  await installWorkspaceProject({ projectDir: project, store, registry });
  const { createRequire } = await import("node:module"),
    require = createRequire(import.meta.url),
    Arborist = require("@npmcli/arborist");
  expect(require("@npmcli/arborist/package.json").version).toBe("10.0.3");
  const tree = await new Arborist({
    path: project,
    offline: true,
    ignoreScripts: true,
  }).loadVirtual();
  const pure = tree.edgesOut.get("pure");
  expect(pure?.valid).toBe(true);
  expect(pure.to.package.version).toBe("1.0.0");
  const a = tree.edgesOut.get("a").to.target,
    plugin = a.edgesOut.get("plugin");
  expect(plugin?.valid).toBe(true);
  expect(plugin.to.package.version).toBe("1.0.0");
  expect(plugin.to.edgesOut.get("b")?.valid).toBe(true);
  expect(plugin.to.edgesOut.get("b").to.target.location).toBe("packages/b");
});
it("applies source-bound workspace patches only inside a complete private external graph", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const shared = await realpath(path.join(project, "node_modules/pure")),
    lock = JSON.parse(
      await readFile(path.join(project, "package-lock.json"), "utf8"),
    ),
    node = lock.zyrk.workspaceGraph.nodes.find(
      (n: { name: string }) => n.name === "pure",
    );
  const { readSourceManifest } = await import("../src/store/manifests.ts"),
    { sha512Hex } = await import("../src/util/hash.ts"),
    source = await readSourceManifest(store, node.sourceId);
  const artifact = `.zyrk/patches/${node.sourceId}.json`;
  await mkdir(path.join(project, ".zyrk/patches"), { recursive: true });
  await writeFile(
    path.join(project, artifact),
    JSON.stringify({
      schemaVersion: 1,
      sourceId: node.sourceId,
      manifestHash: source.manifestHash,
      changes: [
        {
          path: "index.js",
          before: sha512Hex("module.exports=42;"),
          content: Buffer.from("module.exports=93;").toString("base64"),
          executable: false,
        },
      ],
    }),
  );
  const file = path.join(project, "package.json"),
    m = JSON.parse(await readFile(file, "utf8"));
  m.zyrk = { patches: { [node.sourceId]: artifact } };
  await writeFile(file, JSON.stringify(m));
  await installWorkspaceProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("pure"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("93");
  expect(await readFile(path.join(shared, "index.js"), "utf8")).toBe(
    "module.exports=42;",
  );
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    offline: true,
    frozen: true,
  });
});
it("rejects npm package selections that disagree with the authoritative workspace graph", async () => {
  await installWorkspaceProject({ projectDir: project, store, registry });
  const file = path.join(project, "package-lock.json"),
    lock = JSON.parse(await readFile(file, "utf8"));
  lock.packages["node_modules/pure"].version = "2.0.0";
  await writeFile(file, JSON.stringify(lock));
  await expect(
    installWorkspaceProject({
      projectDir: project,
      store,
      registry,
      frozen: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
});
it.each([2, 3])(
  "adopts npm v%s exact workspace selections with live peers and frozen offline reuse",
  async (lockfileVersion) => {
    const { installProject } = await import("../src/install/run.ts");
    const pure = (await registry.packument("pure")).versions["1.0.0"]!;
    const plugin = (await registry.packument("plugin")).versions["1.0.0"]!;
    const pure2 = (await registry.packument("pure")).versions["2.0.0"]!;
    const rootManifest = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    );
    rootManifest.dependencies.a = "*";
    rootManifest.dependencies.pure = "*";
    rootManifest.dependencies.renamed = "npm:pure@1.0.0";
    rootManifest.dependencies.linked = "file:packages/b";
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify(rootManifest),
    );
    const aManifest = JSON.parse(
      await readFile(path.join(project, "packages/a/package.json"), "utf8"),
    );
    aManifest.dependencies.b = "*";
    aManifest.dependencies.pure = "2.0.0";
    await writeFile(
      path.join(project, "packages/a/package.json"),
      JSON.stringify(aManifest),
    );
    await writeFile(
      path.join(project, "packages/a/index.js"),
      'module.exports=[require("b"),require("plugin"),require("pure")];',
    );
    const packages = {
      "": JSON.parse(
        await readFile(path.join(project, "package.json"), "utf8"),
      ),
      "packages/a": JSON.parse(
        await readFile(path.join(project, "packages/a/package.json"), "utf8"),
      ),
      "packages/b": JSON.parse(
        await readFile(path.join(project, "packages/b/package.json"), "utf8"),
      ),
      "node_modules/a": { resolved: "packages/a", link: true },
      "node_modules/b": { resolved: "packages/b", link: true },
      "node_modules/pure": {
        version: "1.0.0",
        resolved: pure.dist.tarball,
        integrity: pure.dist.integrity,
      },
      "node_modules/linked": { resolved: "packages/b", link: true },
      "node_modules/renamed": {
        name: "pure",
        version: "1.0.0",
        resolved: pure.dist.tarball,
        integrity: pure.dist.integrity,
      },
      "packages/a/node_modules/pure": {
        version: "2.0.0",
        resolved: pure2.dist.tarball,
        integrity: pure2.dist.integrity,
      },
      "node_modules/plugin": {
        version: "1.0.0",
        resolved: plugin.dist.tarball,
        integrity: plugin.dist.integrity,
        peerDependencies: { b: "*" },
      },
    };
    await writeFile(
      path.join(project, "package-lock.json"),
      JSON.stringify({ lockfileVersion, packages }),
    );
    await installProject({
      projectDir: project,
      store,
      registry,
      importNpm: true,
    });
    expect(
      (
        await exec(
          process.execPath,
          [
            "-e",
            'const [a,b]=require("a");if(a!==b)throw Error("peer");console.log(require("pure"),require("renamed"),require("a")[2]);',
          ],
          { cwd: project },
        )
      ).stdout.trim(),
    ).toBe("42 42 84");
    expect(
      (
        await exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import a from "a"; import pure from "pure"; console.log(a[2],pure)',
          ],
          { cwd: project },
        )
      ).stdout.trim(),
    ).toBe("84 42");
    const { createRequire } = await import("node:module"),
      require = createRequire(import.meta.url),
      Arborist = require("@npmcli/arborist");
    expect(require("@npmcli/arborist/package.json").version).toBe("10.0.3");
    const tree = await new Arborist({
      path: project,
      offline: true,
      ignoreScripts: true,
    }).loadVirtual();
    expect(tree.edgesOut.get("pure").to.package.version).toBe("1.0.0");
    const a = tree.edgesOut.get("a").to.target;
    expect(a.edgesOut.get("pure").to.package.version).toBe("2.0.0");
    expect(a.edgesOut.get("plugin").to.edgesOut.get("b").valid).toBe(true);

    await installProject({
      projectDir: project,
      store,
      registry,
      frozen: true,
      offline: true,
    });
  },
);
it.each([2, 3])(
  "rejects malformed npm v%s workspace links without changing the lock or projection",
  async (lockfileVersion) => {
    const lock = JSON.stringify({
      lockfileVersion,
      packages: {
        "": {},
        "node_modules/a": { link: true, resolved: "../outside" },
      },
    });
    await writeFile(path.join(project, "package-lock.json"), lock);
    await expect(
      installWorkspaceProject({
        projectDir: project,
        store,
        registry,
        importNpm: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    expect(
      await readFile(path.join(project, "package-lock.json"), "utf8"),
    ).toBe(lock);
    await expect(
      realpath(path.join(project, ".zyrk-local")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      realpath(path.join(project, "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("refuses npm shrinkwrap precedence before creating workspace import state", async () => {
  await writeFile(path.join(project, "npm-shrinkwrap.json"), "{}");
  await writeFile(path.join(project, "package-lock.json"), "{}");
  await expect(
    installWorkspaceProject({
      projectDir: project,
      store,
      registry,
      importNpm: true,
    }),
  ).rejects.toThrow(/shrinkwrap/);
  await expect(
    realpath(path.join(project, ".zyrk-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses unrepresentable npm binary metadata before creating workspace state", async () => {
  const pure = (await registry.packument("pure")).versions["1.0.0"]!;
  const packages: Record<string, unknown> = {};
  for (const relative of ["", "packages/a", "packages/b"])
    packages[relative] = JSON.parse(
      await readFile(path.join(project, relative, "package.json"), "utf8"),
    );
  packages["node_modules/a"] = { link: true, resolved: "packages/a" };
  packages["node_modules/b"] = { link: true, resolved: "packages/b" };
  packages["node_modules/pure"] = {
    version: "1.0.0",
    resolved: pure.dist.tarball,
    integrity: pure.dist.integrity,
    bin: { pure: "../escape.js" },
  };
  const plugin = (await registry.packument("plugin")).versions["1.0.0"]!;
  packages["node_modules/plugin"] = {
    version: "1.0.0",
    resolved: plugin.dist.tarball,
    integrity: plugin.dist.integrity,
    peerDependencies: { b: "*" },
  };
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  await expect(
    installWorkspaceProject({
      projectDir: project,
      store,
      registry,
      importNpm: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
  await expect(
    realpath(path.join(project, ".zyrk-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports verified source reuse for workspace installs and ticks committed dependencies", async () => {
  const events: import("../src/install/run.ts").InstallProgress[] = [];
  await installWorkspaceProject({ projectDir: project, store, registry });
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry,
    offline: true,
    onProgress: (e) => events.push(e),
  });
  expect(events.some((e) => e.package?.status === "reused")).toBe(true);
  expect(events.some((e) => e.package?.status === "downloading")).toBe(false);
  expect(
    events.some(
      (e) => e.package?.status === "linked" && e.package.name === "pure",
    ),
  ).toBe(true);
});
