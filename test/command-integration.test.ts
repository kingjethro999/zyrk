import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "../src/cli/main.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-command-integration-"));
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="original";' } },
        },
      ],
    },
    {
      name: "built",
      versions: [
        {
          version: "1.0.0",
          scripts: { postinstall: "node build.js" },
          files: {
            "build.js": {
              data: 'require("fs").writeFileSync("built.txt", "built");',
            },
            "index.js": { data: 'module.exports="built";' },
          },
        },
      ],
    },
  ]);
  registry = new RegistryClient({ registry: server.url, userAgent: "test" });
  await writeFile(
    path.join(project, "package.json"),
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
async function cli(...argv: string[]) {
  let stdout = "",
    stderr = "";
  const code = await runCli({
    argv,
    env: { ...process.env, ZYRK_STORE_DIR: store.root },
    cwd: project,
    tools: async () => ({ store, registry }),
    stdout: {
      write: (v) => {
        stdout += v;
      },
    },
    stderr: {
      write: (v) => {
        stderr += v;
      },
    },
  });
  return { code, stdout, stderr };
}
async function json(...args: string[]) {
  const result = await cli("--json", ...args);
  return {
    ...result,
    result: JSON.parse(result.stdout || result.stderr) as Record<
      string,
      unknown
    >,
  };
}
it("routes frozen fetch and offline audit through the native handlers", async () => {
  expect((await cli("install", "--lockfile-only")).code).toBe(0);
  const before = await readFile(
    path.join(project, "package-lock.json"),
    "utf8",
  );
  expect((await json("fetch", "--frozen-lockfile")).result).toMatchObject({
    readiness: "fetched",
    status: "ok",
  });
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect((await json("audit", "--offline")).result).toMatchObject({
    status: "unavailable",
  });
  expect((await cli("audit", "--offline")).code).toBe(1);
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
});
it("approves reviewed build candidates and rebuilds at a new private path", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { built: "1.0.0" } }),
  );
  const review = await json("approve-builds");
  expect(review.code).toBe(0);
  expect(review.result.readiness).toBe("build-review");
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect((await cli("approve-builds", "built")).code).toBe(0);
  const workspacePolicy = JSON.parse(
    await readFile(path.join(project, "zyrk-workspace.json"), "utf8"),
  ) as { schemaVersion: number; approvedBuilds: Array<{ name: string }> };
  expect(workspacePolicy).toMatchObject({
    schemaVersion: 1,
    approvedBuilds: [expect.objectContaining({ name: "built" })],
  });
  expect((await cli("install")).code).toBe(0);
  const listed = await json("list");
  expect(listed.result.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "built", realization: "private" }),
    ]),
  );
  const first = await realpath(path.join(project, "node_modules/built"));
  expect(await readFile(path.join(first, "built.txt"), "utf8")).toBe("built");
  expect((await cli("rebuild", "--offline")).code).toBe(0);
  expect(await realpath(path.join(project, "node_modules/built"))).not.toBe(
    first,
  );
});
it("commits and applies a portable patch without changing shared package files", async () => {
  expect((await cli("install")).code).toBe(0);
  const original = await realpath(
    path.join(project, "node_modules/alpha/index.js"),
  );
  const edit = (await json("patch", "alpha")).result;
  expect(typeof edit.editingArea).toBe("string");
  await writeFile(
    path.join(String(edit.editingArea), "index.js"),
    'module.exports="patched";',
  );
  const committed = await json("patch-commit", String(edit.editingArea));
  expect(committed.code).toBe(0);
  expect((await cli("install", "--frozen-lockfile")).code).toBe(1);
  expect((await cli("install")).code).toBe(0);
  const selected = await realpath(
    path.join(project, "node_modules/alpha/index.js"),
  );
  expect(selected).toContain(".zyrk-local/generations/");
  expect(await readFile(selected, "utf8")).toBe('module.exports="patched";');
  expect(await readFile(original, "utf8")).toBe('module.exports="original";');
  expect((await cli("install", "--frozen-lockfile", "--offline")).code).toBe(0);
  const artifact = String(committed.result.artifact);
  const delta = JSON.parse(
    await readFile(path.join(project, artifact), "utf8"),
  ) as { manifestHash: string };
  delta.manifestHash = "0".repeat(128);
  await writeFile(path.join(project, artifact), JSON.stringify(delta));
  expect((await cli("install")).code).toBe(1);
  expect(
    await realpath(path.join(project, "node_modules/alpha/index.js")),
  ).not.toBe(original);
});
it("rejects global add before initializing a tool environment", async () => {
  let opened = false;
  const code = await runCli({
    argv: ["add", "-g", "alpha"],
    env: {},
    cwd: project,
    tools: async () => {
      opened = true;
      return { store, registry };
    },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  expect(code).toBe(1);
  expect(opened).toBe(false);
});

it("store path reads no registry credentials and does not initialize a store", async () => {
  const absent = path.join(root, "not-created-store");
  await writeFile(
    path.join(project, ".npmrc"),
    "@private:registry=https://private.invalid/\nstrict-ssl=false\n",
  );
  let stdout = "";
  const code = await runCli({
    argv: ["--json", "store", "path"],
    cwd: project,
    env: { ...process.env, ZYRK_STORE_DIR: absent },
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
    stderr: { write: () => {} },
  });
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ path: absent });
  expect(await pathExists(absent)).toBe(false);
});

it("routes offline repair through immutable full-closure publication", async () => {
  expect((await cli("install")).code).toBe(0);
  const before = await realpath(path.join(project, "node_modules/alpha"));
  expect((await cli("repair", "--offline")).code).toBe(0);
  const after = await realpath(path.join(project, "node_modules/alpha"));
  expect(after).not.toBe(before);
  expect((await cli("install", "--offline", "--frozen-lockfile")).code).toBe(0);
  expect(await realpath(path.join(project, "node_modules/alpha"))).toBe(after);
});
