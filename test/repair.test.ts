import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  stat,
  chmod,
  readlink,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { installProject } from "../src/install/run.ts";
import { lockedGraph } from "../src/install/lock.ts";
import { prepareRepair } from "../src/install/repair.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { readSourceManifest } from "../src/store/manifests.ts";
import { objectPathFor } from "../src/store/objects.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
const exec = promisify(execFile);
let root: string,
  project: string,
  other: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-repair-"));
  project = path.join(root, "app");
  other = path.join(root, "other");
  await mkdir(project);
  await mkdir(other);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          deps: { beta: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("beta");' } },
        },
      ],
    },
    {
      name: "beta",
      versions: [
        {
          version: "1.0.0",
          deps: { gamma: "1.0.0" },
          files: { "index.js": { data: 'module.exports="verified";' } },
        },
      ],
    },
    {
      name: "gamma",
      versions: [
        {
          version: "1.0.0",
          deps: { beta: "1.0.0" },
          files: { "index.js": { data: 'module.exports="gamma";' } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
    retries: 0,
  });
  for (const dir of [project, other])
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { alpha: "1.0.0" },
      }),
    );
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
function install(
  projectDir = project,
  extra: Partial<Parameters<typeof installProject>[0]> = {},
) {
  return installProject({ projectDir, store, registry, ...extra });
}
async function selectedNodes() {
  return lockedGraph(
    JSON.parse(await readFile(path.join(project, "package-lock.json"), "utf8")),
  ).nodes;
}

test("repair replaces corrupt CAS inodes and entire reverse closure without changing another project", async () => {
  await install();
  await install(other);
  const oldParent = await realpath(path.join(project, "node_modules/alpha"));
  const beta = await realpath(path.join(oldParent, "../beta"));
  const oldBetaInode = (await stat(path.join(beta, "index.js"))).ino;
  const otherLink = await readlink(path.join(other, "node_modules/alpha"));
  await chmod(path.join(beta, "index.js"), 0o644);
  await writeFile(path.join(beta, "index.js"), 'module.exports="corrupt!";');
  await expect(install(project, { frozen: true })).rejects.toMatchObject({
    code: "ZYRK_STORE_CORRUPT",
  });
  await install(project, { frozen: true, repair: true });
  const newParent = await realpath(path.join(project, "node_modules/alpha"));
  const newBeta = await realpath(path.join(newParent, "../beta"));
  expect(newParent).not.toBe(oldParent);
  expect(newBeta).not.toBe(beta);
  const gamma = await realpath(path.join(newBeta, "../gamma"));
  expect(await realpath(path.join(gamma, "../beta"))).toBe(newBeta);
  expect((await stat(path.join(newBeta, "index.js"))).ino).not.toBe(
    oldBetaInode,
  );
  expect(await readFile(path.join(beta, "index.js"), "utf8")).toContain(
    "corrupt!",
  );
  expect(await readlink(path.join(other, "node_modules/alpha"))).toBe(
    otherLink,
  );
  expect(await realpath(path.join(other, "node_modules/alpha"))).toBe(
    oldParent,
  );
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("alpha"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("verified");
  await install(project, { frozen: true });
  expect(await realpath(path.join(project, "node_modules/alpha"))).toBe(
    newParent,
  );
  const nodes = await selectedNodes();
  const child = nodes.find((n) => n.name === "beta")!;
  const manifest = await readSourceManifest(store, child.sourceId);
  const entry = manifest.manifest.entries.find((e) => e.path === "index.js");
  if (entry?.type !== "file") throw Error("missing file");
  expect((await stat(objectPathFor(store, entry.objectId))).ino).not.toBe(
    oldBetaInode,
  );
});

test("offline repair refuses before quarantining verified-source metadata or corrupted objects", async () => {
  await install();
  const alpha = await realpath(path.join(project, "node_modules/alpha"));
  const beta = await realpath(path.join(alpha, "../beta"));
  await chmod(path.join(beta, "index.js"), 0o644);
  await writeFile(path.join(beta, "index.js"), "corrupt");
  const nodes = await selectedNodes();
  const child = nodes.find((n) => n.name === "beta")!;
  const before = await readSourceManifest(store, child.sourceId);
  await expect(
    prepareRepair({ store, graphNodes: nodes, offline: true }),
  ).rejects.toMatchObject({ code: "ZYRK_OFFLINE_MISSING" });
  expect(await readSourceManifest(store, child.sourceId)).toEqual(before);
});

test("repair rejects path-like source identities before filesystem mutation", async () => {
  await expect(
    prepareRepair({
      store,
      graphNodes: [
        {
          sourceId: "../outside",
          name: "alpha",
          version: "1.0.0",
          origin: server.origin,
          integrity: "sha512-fake",
        },
      ],
      offline: false,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_STORE_CORRUPT" });
});

test("repair never quarantines files reached through a symlinked CAS shard", async () => {
  await install();
  const nodes = await selectedNodes();
  const child = nodes.find((n) => n.name === "beta")!;
  const source = await readSourceManifest(store, child.sourceId);
  const entry = source.manifest.entries.find((e) => e.path === "index.js");
  if (entry?.type !== "file") throw Error("missing file");
  const { rename, symlink } = await import("node:fs/promises");
  const shard = path.dirname(objectPathFor(store, entry.objectId));
  const external = path.join(root, "external");
  await mkdir(external);
  await writeFile(path.join(external, entry.objectId), "external bytes");
  await rename(shard, `${shard}-original`);
  await symlink(external, shard);
  await expect(
    prepareRepair({ store, graphNodes: nodes }),
  ).rejects.toMatchObject({ code: "ZYRK_STORE_UNSAFE" });
  expect(await readFile(path.join(external, entry.objectId), "utf8")).toBe(
    "external bytes",
  );
});

test("an inconsistent source digest quarantines its manifest without quarantining healthy CAS content", async () => {
  await install();
  const nodes = await selectedNodes();
  const child = nodes.find((n) => n.name === "beta")!;
  const source = await readSourceManifest(store, child.sourceId);
  const entry = source.manifest.entries.find((e) => e.path === "index.js");
  if (entry?.type !== "file") throw Error("missing file");
  const originalObject = objectPathFor(store, entry.objectId);
  const original = await readFile(originalObject, "utf8");
  entry.innerDigest = "00".repeat(64);
  const { manifestHashOf } = await import("../src/util/hash.ts");
  const { sourceManifestPath } = await import("../src/store/manifests.ts");
  source.manifestHash = manifestHashOf(source.manifest);
  const filename = sourceManifestPath(store, child.sourceId);
  await chmod(filename, 0o644);
  await writeFile(filename, JSON.stringify(source));
  const repair = await prepareRepair({ store, graphNodes: nodes });
  expect(repair.quarantinedSources).toContain(child.sourceId);
  expect(repair.quarantinedObjects).not.toContain(entry.objectId);
  expect(await readFile(originalObject, "utf8")).toBe(original);
});

test("store verification, pins and GC recognize complete repaired physical incarnations", async () => {
  await install();
  await install(project, { frozen: true, repair: true });
  const { runStoreCommand } = await import("../src/commands/store.ts");
  const run = (args: string[]) =>
    runStoreCommand({ command: "store", args, store, cwd: project });
  await expect(run(["verify", "--full"])).resolves.toMatchObject({
    verified: true,
    realizations: 6,
  });
  await expect(run(["pin", project])).resolves.toHaveProperty("pinId");
  const report = (await run(["gc", "--dry-run"])) as {
    candidates: Array<{ path: string }>;
  };
  expect(
    report.candidates.some((candidate) =>
      candidate.path.includes("__repair1_"),
    ),
  ).toBe(false);
});

test("deploy reads the verified repaired incarnation rather than its corrupt canonical predecessor", async () => {
  await install();
  const alpha = await realpath(path.join(project, "node_modules/alpha"));
  const beta = await realpath(path.join(alpha, "../beta"));
  await chmod(path.join(beta, "index.js"), 0o644);
  await writeFile(path.join(beta, "index.js"), "corrupt");
  await install(project, { frozen: true, repair: true });
  await writeFile(
    path.join(project, "app.cjs"),
    'console.log(require("alpha"));',
  );
  const out = path.join(root, "deploy");
  const { runDeployCommand } = await import("../src/commands/deploy.ts");
  await runDeployCommand({
    command: "deploy",
    args: ["--out", out, "--files", "app.cjs", "--entry", "app.cjs"],
    cwd: project,
    env: { ...process.env, ZYRK_STORE_DIR: store.root },
    stdout: { write() {} },
    stderr: { write() {} },
  });
  expect(
    (await exec(process.execPath, ["app.cjs"], { cwd: out })).stdout.trim(),
  ).toBe("verified");
});

test("a grace-retained repaired parent protects its exact transitive child incarnation", async () => {
  await install();
  await install(project, { frozen: true, repair: true });
  const parent = await realpath(path.join(project, "node_modules/alpha"));
  const child = await realpath(path.join(parent, "../beta"));
  const state = JSON.parse(
    await readFile(
      path.join(project, "node_modules/.zyrk/install-state.json"),
      "utf8",
    ),
  );
  const { runStoreCommand } = await import("../src/commands/store.ts");
  await runStoreCommand({
    command: "projects",
    args: ["forget", state.projectId],
    store,
    cwd: project,
  });
  const run = (args: string[]) =>
    runStoreCommand({ command: "store", args, store, cwd: project });
  await run(["gc"]);
  const marksFile = path.join(store.paths.metadataDir, "gc-unreferenced.json");
  const marks = JSON.parse(await readFile(marksFile, "utf8"));
  for (const key of Object.keys(marks))
    marks[key] = Date.now() - 31 * 86400_000;
  delete marks[path.relative(store.root, path.resolve(parent, "../.."))];
  await writeFile(marksFile, JSON.stringify(marks));
  await run(["gc"]);
  expect(await realpath(path.join(parent, "../beta"))).toBe(child);
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("alpha"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("verified");
});

test("deploy refuses private generations before creating an output directory", async () => {
  await install();
  const statePath = path.join(project, "node_modules/.zyrk/install-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.linker = "private";
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(
    path.join(project, "app.cjs"),
    'console.log(require("alpha"));',
  );
  const out = path.join(root, "private-deploy");
  const { runDeployCommand } = await import("../src/commands/deploy.ts");
  await expect(
    runDeployCommand({
      command: "deploy",
      args: ["--out", out, "--files", "app.cjs", "--entry", "app.cjs"],
      cwd: project,
      env: { ...process.env, ZYRK_STORE_DIR: store.root },
      stdout: { write() {} },
      stderr: { write() {} },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
  const { access } = await import("node:fs/promises");
  await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
});

test("private repair indexes shared replacements and warm installs prefer their coherent repair family", async () => {
  await install();
  await install(other);
  const canonical = await realpath(path.join(other, "node_modules/alpha"));
  const beta = await realpath(path.join(canonical, "../beta"));
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.zyrk = { mutablePackages: ["alpha"] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await install();
  expect(
    (await realpath(path.join(project, "node_modules/alpha"))).startsWith(
      path.join(project, ".zyrk-local"),
    ),
  ).toBe(true);
  await chmod(path.join(beta, "index.js"), 0o644);
  await writeFile(path.join(beta, "index.js"), "corrupted");
  await install(project, { frozen: true, repair: true });
  const { openStoreDb } = await import("../src/store/db.ts");
  const sharedRepairs = () => {
    const db = openStoreDb(store.paths.dbFile);
    try {
      return db
        .prepare(
          "SELECT instance_id,path,repair_of FROM realization_instances WHERE path LIKE ? ORDER BY path",
        )
        .all(`${store.paths.realizationsDir}/%__repair1_%`) as Array<{
        instance_id: string;
        path: string;
        repair_of: string | null;
      }>;
    } finally {
      db.close();
    }
  };
  const before = sharedRepairs();
  expect(before).toHaveLength(3);
  expect(before.every((instance) => instance.repair_of !== null)).toBe(true);
  await install(project, { frozen: true });
  expect(sharedRepairs()).toEqual(before);
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("alpha"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("verified");
  expect(await realpath(path.join(other, "node_modules/alpha"))).toBe(
    canonical,
  );
});
