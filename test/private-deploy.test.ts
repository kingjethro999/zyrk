import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  lstat,
  symlink,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { installProject } from "../src/install/run.ts";
import { runPatchCommand } from "../src/commands/patch.ts";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
const exec = promisify(execFile);
let root: string,
  project: string,
  store: Store,
  registry: RegistryClient,
  server: StubRegistry;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-private-deploy-"));
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "host",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="original";' } },
        },
      ],
    },
    {
      name: "builder",
      versions: [
        {
          version: "1.0.0",
          deps: { host: "1.0.0" },
          scripts: { postinstall: "node build.cjs" },
          files: {
            "index.js": {
              data: 'module.exports=require("./alias.cjs")+":"+require("host");',
            },
            "build.cjs": {
              data: 'const fs=require("fs"),path=require("path");fs.writeFileSync("generated.cjs",\'module.exports="generated";\');fs.symlinkSync(path.join(process.cwd(),"generated.cjs"),"alias.cjs");',
            },
          },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
    retries: 0,
  });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { builder: "1.0.0", host: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "app.cjs"),
    'console.log(require("builder"));',
  );
  await installProject({
    projectDir: project,
    store,
    registry,
    reviewBuilds: true,
    approveBuilds: ["builder"],
  });
  await installProject({ projectDir: project, store, registry });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
function deploy(out: string) {
  return runDeployCommand({
    command: "deploy",
    args: ["--out", out, "--files", "app.cjs", "--entry", "app.cjs"],
    cwd: project,
    env: { ...process.env, ZYRK_STORE_DIR: store.root },
    stdout: { write() {} },
    stderr: { write() {} },
  });
}
test("exports patched JS private payloads and generated files without project/store access", async () => {
  const edit = (await runPatchCommand({
    command: "patch",
    args: ["host"],
    store,
    cwd: project,
  })) as { editingArea: string };
  await writeFile(
    path.join(edit.editingArea, "index.js"),
    'module.exports="patched";',
  );
  await runPatchCommand({
    command: "patch-commit",
    args: [edit.editingArea],
    store,
    cwd: project,
  });
  await installProject({
    projectDir: project,
    store,
    registry,
    reviewBuilds: true,
    approveBuilds: ["builder"],
  });
  await installProject({ projectDir: project, store, registry });
  const original = await realpath(
    path.join(project, "node_modules/builder/generated.cjs"),
  );
  const inode = (await lstat(original)).ino;
  const out = path.join(root, "runtime");
  await deploy(out);
  const runtimeFile = await realpath(
    path.join(out, "node_modules/builder/generated.cjs"),
  );
  expect((await lstat(runtimeFile)).ino).not.toBe(inode);
  expect((await lstat(runtimeFile)).nlink).toBe(1);
  await rmrfNoFollow(project);
  await rmrfNoFollow(store.root);
  expect(
    (await exec(process.execPath, ["app.cjs"], { cwd: out })).stdout.trim(),
  ).toBe("generated:patched");
});
test("refuses absolute host path outputs and native outputs before publishing", async () => {
  const builder = await realpath(path.join(project, "node_modules/builder"));
  await writeFile(
    path.join(builder, "host-path.txt"),
    JSON.stringify({ root: store.root }),
  );
  const out = path.join(root, "bad-path");
  await expect(deploy(out)).rejects.toMatchObject({
    code: "ZYRK_DEPLOY_NONRELOCATABLE",
  });
  await expect(lstat(out)).rejects.toMatchObject({ code: "ENOENT" });
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(builder, "host-path.txt"));
  await writeFile(
    path.join(builder, "native.bin"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
  );
  await expect(deploy(path.join(root, "bad-native"))).rejects.toMatchObject({
    code: "ZYRK_DEPLOY_NONRELOCATABLE",
  });
});
test("refuses escaping private links and mismatched build ABI", async () => {
  const builder = await realpath(path.join(project, "node_modules/builder"));
  await symlink(
    path.join(project, "app.cjs"),
    path.join(builder, "escape.cjs"),
  );
  await expect(deploy(path.join(root, "escape"))).rejects.toMatchObject({
    code: "ZYRK_DEPLOY_ESCAPE",
  });
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(builder, "escape.cjs"));
  const statePath = path.join(project, "node_modules/.zyrk/install-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.buildProfile.abi = "invalid";
  await writeFile(statePath, JSON.stringify(state));
  await expect(deploy(path.join(root, "abi"))).rejects.toMatchObject({
    code: "ZYRK_PLATFORM_UNSUPPORTED",
  });
});

test("refuses private credential filenames and credential bytes, including chunk boundaries", async () => {
  const builder = await realpath(path.join(project, "node_modules/builder"));
  const cases = [
    { name: ".npmrc", data: "registry=https://registry.example/" },
    { name: "generated.txt", data: "npm_" + "a".repeat(36) },
    { name: "generated.txt", data: "-----BEGIN RSA PRIVATE KEY-----" },
    { name: "generated.txt", data: "https://user:password@registry.example/" },
    {
      name: "generated.txt",
      data: "//registry.example/:_authToken=credential",
    },
    {
      name: "generated.txt",
      data: " ".repeat(1024 * 1024 - 7) + "npm_" + "b".repeat(36),
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const file = path.join(builder, fixture.name);
    await writeFile(file, fixture.data);
    const out = path.join(root, "credential-" + index);
    await expect(deploy(out)).rejects.toMatchObject({
      code: "ZYRK_DEPLOY_NONRELOCATABLE",
    });
    await expect(lstat(out)).rejects.toMatchObject({ code: "ENOENT" });
    await unlink(file);
  }
});

test("refuses explicit application selections beneath a symlink ancestor", async () => {
  await mkdir(path.join(root, "external"));
  await writeFile(path.join(root, "external/server.cjs"), "console.log(1)");
  await symlink(path.join(root, "external"), path.join(project, "linked"));
  const out = path.join(root, "linked-app");
  await expect(
    runDeployCommand({
      command: "deploy",
      args: [
        "--out",
        out,
        "--files",
        "linked/server.cjs",
        "--entry",
        "linked/server.cjs",
      ],
      cwd: project,
      env: { ...process.env, ZYRK_STORE_DIR: store.root },
      stdout: { write() {} },
      stderr: { write() {} },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_ESCAPE" });
  await expect(lstat(out)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses a projection selecting a different private package", async () => {
  const builder = await realpath(path.join(project, "node_modules/builder"));
  await unlink(path.join(project, "node_modules/host"));
  await symlink(builder, path.join(project, "node_modules/host"));
  await expect(deploy(path.join(root, "wrong-instance"))).rejects.toMatchObject(
    {
      code: "ZYRK_DEPLOY_ESCAPE",
    },
  );
});

test("refuses policy changes after the selected private build", async () => {
  const file = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.zyrk = { ...manifest.zyrk, mutablePackages: ["host"] };
  await writeFile(file, JSON.stringify(manifest));
  await expect(deploy(path.join(root, "stale-policy"))).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
});

test("rejects a forged workspace lock extension before export", async () => {
  const file = path.join(project, "package-lock.json");
  const lock = JSON.parse(await readFile(file, "utf8"));
  lock.zyrk.version = 2;
  await writeFile(file, JSON.stringify(lock));
  await expect(
    deploy(path.join(root, "workspace-export")),
  ).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
});
