import { runCli } from "../src/cli/main.ts";
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
import {
  runDependencyCommand,
  type DependencyCommand,
} from "../src/commands/dependencies.ts";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-dependencies-"));
  project = path.join(root, "app");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports = 'old';" } },
        },
        {
          version: "1.1.0",
          files: { "index.js": { data: "module.exports = 'minor';" } },
        },
        {
          version: "2.0.0",
          files: { "index.js": { data: "module.exports = 'major';" } },
        },
      ],
      tags: { latest: "2.0.0" },
    },
    {
      name: "@scope/child",
      versions: [
        {
          version: "1.0.0",
          deps: { alpha: "1.0.0" },
          files: { "index.js": { data: "module.exports = require('alpha');" } },
        },
      ],
    },
    {
      name: "built",
      versions: [
        {
          version: "1.0.0",
          scripts: { postinstall: "touch script-ran" },
          files: { "index.js": { data: "module.exports = 1;" } },
        },
      ],
    },
    {
      name: "broken",
      versions: [
        {
          version: "1.0.0",
          deps: { absent: "1.0.0" },
          files: { "index.js": { data: "module.exports = 1;" } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "zyrk-test/0",
    retries: 0,
  });
  await manifest({ dependencies: { alpha: "^1.0.0" } });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
async function manifest(fields: Record<string, unknown>) {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", ...fields }),
  );
}
function command(command: DependencyCommand, ...args: string[]) {
  return runDependencyCommand({
    command,
    args,
    projectDir: project,
    store,
    registry,
  });
}
function install() {
  return installProject({ projectDir: project, store, registry });
}
async function text(file: string) {
  return readFile(path.join(project, file), "utf8");
}
async function doc(file = "package.json") {
  return JSON.parse(await text(file));
}
async function seedOldLock() {
  await manifest({ dependencies: { alpha: "1.0.0" } });
  await install();
  await manifest({ dependencies: { alpha: "^1.0.0" } });
  const lock = await doc("package-lock.json");
  delete lock.zyrk;
  lock.packages[""].dependencies.alpha = "^1.0.0";
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify(lock),
  );
  await command("import", "--from", "npm");
}
it("adds development, optional, scoped, and aliased roots through shared install", async () => {
  await command("add", "-D", "alternate@npm:alpha@1.0.0");
  expect((await doc()).devDependencies.alternate).toBe("npm:alpha@1.0.0");
  await command("add", "-O", "@scope/child@1.0.0");
  expect((await doc()).optionalDependencies["@scope/child"]).toBe("^1.0.0");
  expect(
    await pathExists(path.join(project, "node_modules/@scope/child/index.js")),
  ).toBe(true);
  expect(
    await pathExists(path.join(project, "node_modules/alternate/index.js")),
  ).toBe(true);
});
it("removes direct roots and their unused closure while preserving another root", async () => {
  await command("add", "@scope/child@1.0.0");
  const target = await realpath(path.join(project, "node_modules/alpha"));
  await command("remove", "@scope/child");
  expect((await doc()).dependencies["@scope/child"]).toBeUndefined();
  expect(
    await pathExists(path.join(project, "node_modules/@scope/child")),
  ).toBe(false);
  expect(await realpath(path.join(project, "node_modules/alpha"))).toBe(target);
  await command("remove", "alpha");
  expect((await doc("package-lock.json")).zyrk.roots["."]).toEqual({});
});
it("moves explicitly added roots between dependency groups without stale version overrides", async () => {
  await manifest({ optionalDependencies: { alpha: "1.0.0" } });
  await install();
  await command("add", "alpha@2.0.0", "-D", "-E");
  expect((await doc()).devDependencies.alpha).toBe("2.0.0");
  expect((await doc()).optionalDependencies?.alpha).toBeUndefined();
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("2.0.0");
  await command("add", "alpha@1.0.0", "-E");
  expect((await doc()).dependencies.alpha).toBe("1.0.0");
  expect((await doc()).devDependencies?.alpha).toBeUndefined();
});
it("updates aliased dev roots by their dependency name and retains their alias", async () => {
  await manifest({ devDependencies: { alternate: "npm:alpha@1.0.0" } });
  await install();
  await command("update", "alternate", "--latest", "-E");
  expect((await doc()).devDependencies.alternate).toBe("npm:alpha@2.0.0");
  expect(
    (await doc("package-lock.json")).packages["node_modules/alternate"].version,
  ).toBe("2.0.0");
});
it("updates inside the declared range and only widens it with --latest", async () => {
  await seedOldLock();
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("1.0.0");
  await command("update", "alpha");
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("1.1.0");
  expect((await doc()).dependencies.alpha).toBe("^1.0.0");
  await command("update", "--latest");
  expect((await doc()).dependencies.alpha).toBe("^2.0.0");
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("2.0.0");
});
it("preserves unselected locked roots during an add and selected update", async () => {
  await seedOldLock();
  await command("add", "@scope/child@1.0.0");
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("1.0.0");
  await command("update", "@scope/child");
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("1.0.0");
});
it("retains state on resolution failure and skips unapproved builds during add", async () => {
  await install();
  const before = [
    await text("package.json"),
    await text("package-lock.json"),
    await realpath(path.join(project, "node_modules/alpha")),
  ];
  await expect(command("add", "broken@1.0.0")).rejects.toMatchObject({
    code: "ZYRK_RESOLUTION_FAILED",
  });
  expect([
    await text("package.json"),
    await text("package-lock.json"),
    await realpath(path.join(project, "node_modules/alpha")),
  ]).toEqual(before);
  const added = await command("add", "built@1.0.0");
  expect(added.readiness).toBe("intentionally-unbuilt");
  expect(await text("package.json")).toContain("built");
  expect(
    await pathExists(path.join(project, "node_modules/built/script-ran")),
  ).toBe(false);
});
it("reports explicit build skipping as intentionally unbuilt", async () => {
  expect(
    (await command("add", "built@1.0.0", "--ignore-scripts")).readiness,
  ).toBe("intentionally-unbuilt");
  expect(
    await pathExists(path.join(project, "node_modules/built/script-ran")),
  ).toBe(false);
});
it("requires a present npm lock for import and preserves exact npm selections", async () => {
  await expect(command("import", "--from", "npm")).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  await seedOldLock();
  expect(
    (await doc("package-lock.json")).packages["node_modules/alpha"].version,
  ).toBe("1.0.0");
  expect((await doc("package-lock.json")).zyrk).toBeDefined();
});
it("rejects incompatible npm requirements even when the target location was visited already", async () => {
  await manifest({ dependencies: { alpha: "1.0.0", "@scope/child": "1.0.0" } });
  await install();
  const lock = await doc("package-lock.json");
  delete lock.zyrk;
  delete lock.packages["node_modules/@scope/child/node_modules/alpha"];
  lock.packages["node_modules/@scope/child"].dependencies.alpha = "^2.0.0";
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify(lock),
  );
  const before = await text("package-lock.json");
  await expect(command("import", "--from", "npm")).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  expect(await text("package-lock.json")).toBe(before);
});
it("rejects unknown flags, absent roots, and malformed command arguments without mutations", async () => {
  await install();
  const before = await text("package-lock.json");
  for (const [cmd, args] of [
    ["add", []],
    ["add", ["alpha", "--unsafe"]],
    ["add", ["alpha", "-D", "-O"]],
    ["remove", []],
    ["remove", ["alpha@1"]],
    ["update", ["--latest", "--unsafe"]],
    ["import", []],
    ["import", ["--from", "yarn"]],
  ] as const)
    await expect(command(cmd, ...args)).rejects.toMatchObject({
      code: "ZYRK_USAGE",
    });
  for (const cmd of ["remove", "update"] as const)
    await expect(command(cmd, "absent")).rejects.toMatchObject({
      code: "ZYRK_USAGE",
    });
  expect(await text("package-lock.json")).toBe(before);
});

it("shows add progress and linked ticks, with JSON output remaining quiet", async () => {
  const chunks: string[] = [];
  const cli = (argv: string[]) =>
    runCli({
      argv,
      cwd: project,
      env: process.env,
      stdout: { write: (s: string) => chunks.push(s) },
      stderr: { write: (s: string) => chunks.push(s) },
      tools: async () => ({ store, registry }),
    });
  await manifest({});
  expect(await cli(["add", "alpha@1.0.0"])).toBe(0);
  expect(chunks.join("")).toContain("downloaded 1");
  expect(chunks.join("")).toContain("✓ alpha@1.0.0 linked");
  chunks.length = 0;
  expect(await cli(["add", "@scope/child@1.0.0", "--json"])).toBe(0);
  expect(JSON.parse(chunks.join("")).status).toBe("ok");
});
