import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installProject } from "../src/install/run.ts";
import { runNextCommand } from "../src/commands/next.ts";
import { runCli } from "../src/cli/main.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
const fault = vi.hoisted(() => ({ target: "" }));
vi.mock("../src/util/fsx.ts", async (original) => {
  const fsx = await original<typeof import("../src/util/fsx.ts")>();
  return {
    ...fsx,
    writeFileAtomic: async (
      ...args: Parameters<typeof fsx.writeFileAtomic>
    ) => {
      await fsx.writeFileAtomic(...args);
      if (args[0] === fault.target)
        throw new Error("injected post-publication durability failure");
    },
  };
});
let root: string, project: string, store: Store, server: StubRegistry;
let options: Parameters<typeof runNextCommand>[0];
let registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-next-turbo-"));
  project = path.join(root, "app");
  await mkdir(project);
  server = await startStubRegistry([
    {
      name: "next",
      versions: ["16.4.2", "16.3.0"].map((version) => ({
        version,
        files: { "index.js": { data: "module.exports=1" } },
      })),
    },
  ]);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { next: "16.4.2" },
    }),
  );
  await writeFile(
    path.join(project, "next.config.mjs"),
    'import fs from "node:fs";\nfs.writeFileSync(new URL("executed", import.meta.url), "yes");\nexport default async (phase, context) => ({ reactStrictMode: true, phase, token: context.token, turbopack: { resolveAlias: {test:"other"} }, experimental: { existingFeature: true } });\n',
  );
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
    retries: 0,
  });
  await installProject({ projectDir: project, store, registry });
  options = {
    cwd: project,
    args: ["--turbopack"],
    env: { ...process.env, ZYRK_STORE_DIR: store.root },
  };
});
afterEach(async () => {
  fault.target = "";
  await server.close();
  await rmrfNoFollow(root);
});
it("requires explicit opt-in and leaves generated configuration unchanged until selected", async () => {
  const before = await readFile(path.join(project, "next.config.mjs"), "utf8");
  await expect(runNextCommand({ ...options, args: [] })).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(path.join(project, "next.config.mjs"), "utf8")).toBe(
    before,
  );
  expect(await pathExists(path.join(project, "executed"))).toBe(false);
});
it("preserves async/function configuration and a readonly original without running it during editing", async () => {
  const original = await readFile(
    path.join(project, "next.config.mjs"),
    "utf8",
  );
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8");
  expect(await runNextCommand(options)).toMatchObject({ changed: true });
  expect(await pathExists(path.join(project, "executed"))).toBe(false);
  expect(
    await readFile(path.join(project, "next.config.zyrk-original.mjs"), "utf8"),
  ).toBe(original);
  expect(
    (await lstat(path.join(project, "next.config.zyrk-original.mjs"))).mode &
      0o222,
  ).toBe(0);
  for (const file of [
    "next.config.mjs",
    "next.config.zyrk-turbopack.cjs",
    "next.config.zyrk-turbopack.d.cts",
  ])
    expect(await readFile(path.join(project, file), "utf8")).not.toContain(
      root,
    );
  const loaded = await import(
    pathToFileURL(path.join(project, "next.config.mjs")).href
  );
  const config = await loaded.default("phase-test", { token: "retained" });
  expect(config).toMatchObject({
    reactStrictMode: true,
    phase: "phase-test",
    token: "retained",
    turbopack: { root: project, resolveAlias: { test: "other" } },
    experimental: {
      existingFeature: true,
      turbopackAdditionalRoots: {
        zyrkStore: { path: store.paths.realizationsDir },
      },
    },
  });
  expect(await runNextCommand(options)).toMatchObject({ changed: false });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
});
it("refuses backup collisions and symlinked configs without overwriting user files", async () => {
  const backup = path.join(project, "next.config.zyrk-original.mjs");
  await writeFile(backup, "user backup");
  await expect(runNextCommand(options)).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(backup, "utf8")).toBe("user backup");
  expect(
    await pathExists(path.join(project, "next.config.zyrk-turbopack.cjs")),
  ).toBe(false);
  await writeFile(path.join(root, "external.mjs"), "export default {};");
  await import("node:fs/promises").then((fs) =>
    fs.unlink(path.join(project, "next.config.mjs")),
  );
  await symlink(
    path.join(root, "external.mjs"),
    path.join(project, "next.config.mjs"),
  );
  await expect(runNextCommand(options)).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
});
it("exposes only the explicit CLI command and returns structured edit status", async () => {
  let output = "";
  expect(
    await runCli({
      argv: ["next", "--turbopack", "--json"],
      cwd: project,
      env: options.env,
      stdout: {
        write(s) {
          output += s;
        },
      },
      stderr: { write() {} },
    }),
  ).toBe(0);
  expect(JSON.parse(output)).toMatchObject({
    command: "next",
    changed: true,
    backup: "next.config.zyrk-original.mjs",
  });
});

it("refuses an installed Next release without additional-root support before editing", async () => {
  const file = path.join(project, "next.config.mjs");
  const before = await readFile(file, "utf8");
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { next: "16.3.0" },
    }),
  );
  await installProject({ projectDir: project, store, registry });
  await expect(runNextCommand(options)).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(file, "utf8")).toBe(before);
  expect(
    await pathExists(path.join(project, "next.config.zyrk-original.mjs")),
  ).toBe(false);
});

it("retains the original and adapter dependencies if configuration publication reports a durability failure", async () => {
  fault.target = path.join(project, "next.config.mjs");
  await expect(runNextCommand(options)).rejects.toThrow(
    "injected post-publication durability failure",
  );
  for (const name of [
    "next.config.mjs",
    "next.config.zyrk-original.mjs",
    "next.config.zyrk-turbopack.cjs",
    "next.config.zyrk-turbopack.d.cts",
  ])
    expect(await pathExists(path.join(project, name))).toBe(true);
  fault.target = "";
  expect(await runNextCommand(options)).toMatchObject({ changed: false });
});

it("refuses nested shared stores and manifest drift before writing configuration", async () => {
  const target = path.join(project, "next.config.mjs");
  const before = await readFile(target, "utf8");
  const nested = await Store.open({
    root: path.join(project, "local-store"),
    create: true,
  });
  await installProject({ projectDir: project, store: nested, registry });
  await expect(
    runNextCommand({
      ...options,
      env: { ...options.env, ZYRK_STORE_DIR: nested.root },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_USAGE" });
  expect(await readFile(target, "utf8")).toBe(before);
  expect(
    await pathExists(path.join(project, "next.config.zyrk-original.mjs")),
  ).toBe(false);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "changed",
      version: "1.0.0",
      dependencies: { next: "16.4.2" },
      devDependencies: { unexpected: "1.0.0" },
    }),
  );
  await expect(runNextCommand(options)).rejects.toMatchObject({
    code: "ZYRK_USAGE",
  });
  expect(await readFile(target, "utf8")).toBe(before);
});
it("writes an extensionless original import for TypeScript Next configurations", async () => {
  const fs = await import("node:fs/promises");
  await fs.unlink(path.join(project, "next.config.mjs"));
  await writeFile(
    path.join(project, "next.config.ts"),
    "const config = {reactStrictMode: true};\nexport default config;\n",
  );
  await runNextCommand(options);
  const generated = await readFile(
    path.join(project, "next.config.ts"),
    "utf8",
  );
  expect(generated).toContain('from "./next.config.zyrk-original"');
  expect(generated).not.toContain('from "./next.config.zyrk-original.ts"');
});
