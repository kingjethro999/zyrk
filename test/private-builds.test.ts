import { isolateUserConfig } from "./helpers/user-config.ts";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  stat,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { installProject } from "../src/install/run.ts";
import { Store } from "../src/store/layout.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { rmrfNoFollow, pathExists } from "../src/util/fsx.ts";
const exec = promisify(execFile);
let configFile: string;
let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-private-"));
  configFile = await isolateUserConfig(root);
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "host",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports={value:"original"};' } },
        },
      ],
    },
    {
      name: "builder",
      versions: [
        {
          version: "1.0.0",
          deps: { host: "1.0.0" },
          peerDeps: { host: "^1.0.0" },
          scripts: { postinstall: "node build.js" },
          files: {
            "index.js": { data: 'module.exports=require("host");' },
            "build.js": {
              data: 'const fs=require("fs");fs.writeFileSync("built.txt",process.cwd());fs.writeFileSync(require.resolve("host"),\'module.exports={value:"private"};\');',
            },
          },
        },
      ],
    },
    {
      name: "failing",
      versions: [
        {
          version: "1.0.0",
          scripts: { install: "exit 7" },
          files: { "index.js": { data: 'module.exports="no";' } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({ registry: server.url, userAgent: "test" });
  await manifest({ dependencies: { builder: "1.0.0", host: "1.0.0" } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
  await rmrfNoFollow(root);
});
async function manifest(fields: Record<string, unknown>) {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", ...fields }),
  );
}
function install(extra: Partial<Parameters<typeof installProject>[0]> = {}) {
  return installProject({ projectDir: project, store, registry, ...extra });
}
it("reviews without code execution and approves exact candidate builds before first install", async () => {
  const review = await install({ reviewBuilds: true });
  expect(review.readiness).toBe("build-review");
  expect(review.builds?.[0]?.name).toBe("builder");
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect(await pathExists(path.join(project, "package-lock.json"))).toBe(false);
  await install({ reviewBuilds: true, approveBuilds: ["builder"] });
  const result = await install();
  expect(result.readiness).toBe("ready");
  const dir = await realpath(path.join(project, "node_modules/builder"));
  expect(dir.startsWith(path.join(project, ".zyrk-local/generations"))).toBe(
    true,
  );
  expect(await readFile(path.join(dir, "built.txt"), "utf8")).toBe(dir);
  expect(
    (
      await exec(
        process.execPath,
        [
          "-e",
          'console.log(require("host")===require("builder"),require("host").value)',
        ],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("true private");
});
it("builds only interactively approved sources and records exact approvals in the workspace file", async () => {
  await manifest({
    dependencies: { builder: "1.0.0", failing: "1.0.0" },
  });
  const result = await install({
    requestBuildApproval: async (builds) => [
      builds.find((build) => build.name === "builder")!.sourceId,
    ],
  });
  expect(result.readiness).toBe("intentionally-unbuilt");
  expect(result.warnings.join(" ")).toContain(
    "1 dependency build script was skipped",
  );
  const approvals = JSON.parse(
    await readFile(path.join(project, "zyrk-workspace.json"), "utf8"),
  );
  expect(approvals).toMatchObject({
    schemaVersion: 1,
    approvedBuilds: [
      { name: "builder", version: "1.0.0", sourceId: expect.any(String) },
    ],
  });
  const directory = await realpath(path.join(project, "node_modules/builder"));
  expect(await readFile(path.join(directory, "built.txt"), "utf8")).toBe(
    directory,
  );
  expect(await pathExists(path.join(project, "node_modules/failing"))).toBe(
    true,
  );
});
it("build writes remain private and a rebuild uses a new stable generation", async () => {
  const second = path.join(root, "second");
  await mkdir(second);
  await writeFile(
    path.join(second, "package.json"),
    JSON.stringify({ dependencies: { host: "1.0.0" } }),
  );
  await install({ projectDir: second });
  const shared = await realpath(
    path.join(second, "node_modules/host/index.js"),
  );
  const before = await readFile(shared, "utf8");
  await install({ reviewBuilds: true, approveBuilds: ["builder"] });
  await install();
  const first = await realpath(path.join(project, "node_modules/builder"));
  await install({ frozen: true, rebuild: true });
  const next = await realpath(path.join(project, "node_modules/builder"));
  expect(next).not.toBe(first);
  expect(await readFile(shared, "utf8")).toBe(before);
  expect((await stat(shared)).ino).not.toBe(
    (await stat(path.join(project, "node_modules/host/index.js"))).ino,
  );
});
it("failed approved builds leave the prior projection and lock selected", async () => {
  await manifest({ dependencies: { host: "1.0.0" } });
  await install();
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  await manifest({ dependencies: { failing: "1.0.0" } });
  await install({ reviewBuilds: true, approveBuilds: ["failing"] });
  await expect(install()).rejects.toMatchObject({ code: "ZYRK_BUILD_FAILED" });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("host").value)'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("original");
});
it("local mandatory denies beat reviewed approvals without rewriting the lock", async () => {
  await install({ reviewBuilds: true, approveBuilds: ["builder"] });
  await install();
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({ scripts: { deny: ["builder"] } }),
  );
  const denied = await install({
    frozen: true,
    env: process.env,
  });
  expect(denied.readiness).toBe("intentionally-unbuilt");
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
});

it("collects unrelated sources while private generations retain their exact source closure", async () => {
  const { runStoreCommand } = await import("../src/commands/store.ts");
  const { Transaction } = await import("../src/store/txn.ts");
  const { fetchAndCommitSource } = await import("../src/fetch/package.ts");
  const { sourceManifestPath } = await import("../src/store/manifests.ts");
  await install({ reviewBuilds: true, approveBuilds: ["builder"] });
  await install();
  const txn = await Transaction.begin(store, "fixture-unreferenced");
  let orphan;
  try {
    orphan = await fetchAndCommitSource({
      store,
      registry,
      txn,
      name: "failing",
      version: "1.0.0",
    });
  } finally {
    await txn.finish();
  }
  const gc = () =>
    runStoreCommand({
      command: "store",
      args: ["gc"],
      store,
      cwd: project,
    }) as Promise<{ retentionReasons: string[]; removed: number }>;
  expect((await gc()).retentionReasons).toEqual([]);
  const marksFile = path.join(store.paths.metadataDir, "gc-unreferenced.json");
  const marks = JSON.parse(await readFile(marksFile, "utf8")) as Record<
    string,
    number
  >;
  for (const key of Object.keys(marks))
    marks[key] = Date.now() - 31 * 86400_000;
  await writeFile(marksFile, JSON.stringify(marks));
  expect((await gc()).removed).toBeGreaterThan(0);
  expect(await pathExists(sourceManifestPath(store, orphan!.sourceId))).toBe(
    false,
  );
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("builder").value)'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("private");
});
