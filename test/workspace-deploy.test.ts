import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
  chmod,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { installWorkspaceProject } from "../src/install/workspace-install.ts";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zyrk-workspace-deploy-"));
  const project = path.join(root, "project");
  for (const p of ["packages/a", "packages/b", "packages/dev"])
    await mkdir(path.join(project, p), { recursive: true });
  const json = async (p: string, value: unknown) =>
    writeFile(path.join(project, p), JSON.stringify(value));
  await json("package.json", {
    name: "app",
    version: "1.0.0",
    workspaces: ["packages/*"],
    files: ["app.cjs", "app.mjs"],
    dependencies: { a: "workspace:*", pure: "1.0.0" },
    devDependencies: { dev: "workspace:*" },
  });
  await json("packages/a/package.json", {
    name: "a",
    version: "1.0.0",
    dependencies: { b: "file:../b", plugin: "1.0.0" },
  });
  await json("packages/b/package.json", {
    name: "b",
    version: "1.0.0",
    dependencies: { a: "workspace:*" },
  });
  await json("packages/dev/package.json", { name: "dev", version: "1.0.0" });
  await writeFile(
    path.join(project, "packages/a/index.js"),
    'exports.value="a"; exports.b=require("b"); exports.same=require("plugin")===exports.b;',
  );
  await writeFile(
    path.join(project, "packages/b/index.js"),
    'exports.value=require("fs").readFileSync(require("path").join(__dirname,"asset.txt"),"utf8"); exports.a=require("a");',
  );
  await writeFile(path.join(project, "packages/b/asset.txt"), "b-asset");
  await writeFile(
    path.join(project, "packages/a/entry.mjs"),
    'import a from "./index.js"; import asset from "b/entry.mjs"; export const esm=asset+"-esm"; export default a;',
  );
  await writeFile(
    path.join(project, "packages/b/entry.mjs"),
    'import {readFileSync} from "node:fs"; export default readFileSync(new URL("./asset.txt",import.meta.url),"utf8");',
  );
  await writeFile(
    path.join(project, "app.cjs"),
    'const a=require("a"); console.log(a.value,a.b.value,a.same,a.b.a===a);',
  );
  await writeFile(
    path.join(project, "app.mjs"),
    'import a,{esm} from "a/entry.mjs"; console.log(a.value,a.b.value,a.same,a.b.a===a,esm);',
  );
  const server = await startStubRegistry([
    {
      name: "pure",
      versions: [
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
          version: "1.0.0",
          peerDeps: { b: "*" },
          files: { "index.js": { data: 'module.exports=require("b");' } },
        },
      ],
    },
  ]);
  const store = await Store.open({
    root: path.join(root, "store"),
    create: true,
  });
  await installWorkspaceProject({
    projectDir: project,
    store,
    registry: new RegistryClient({
      registry: server.url,
      userAgent: "test",
      retries: 0,
    }),
  });
  const deploy = (out: string) =>
    runDeployCommand({
      command: "deploy",
      args: ["--out", out, "--entry", "app.cjs"],
      cwd: project,
      env: { ...process.env, ZYRK_STORE_DIR: store.root },
      stdout: { write() {} },
      stderr: { write() {} },
    });
  return { root, project, store, server, deploy };
}
it("exports live local cycles, peer singleton identity, CJS/ESM and assets without the host project or store", async () => {
  const f = await fixture();
  try {
    const out = path.join(f.root, "runtime");
    await f.deploy(out);
    const manifest = JSON.parse(
      await readFile(path.join(out, "package.json"), "utf8"),
    );
    expect(manifest.devDependencies).toBeUndefined();
    await rmrfNoFollow(f.project);
    await rmrfNoFollow(f.store.root);
    for (const [entry, expected] of [
      ["app.cjs", "a b-asset true true"],
      ["app.mjs", "a b-asset true true b-asset-esm"],
    ])
      expect(
        (
          await exec(process.execPath, [entry!], {
            cwd: out,
            env: { PATH: process.env.PATH },
          })
        ).stdout.trim(),
      ).toBe(expected);
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});
it("rejects a live package payload link outside its declared source root", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "outside"), "secret");
    await symlink(
      path.join(f.root, "outside"),
      path.join(f.project, "packages/b/escape"),
    );
    await expect(f.deploy(path.join(f.root, "runtime"))).rejects.toMatchObject({
      code: "ZYRK_DEPLOY_ESCAPE",
    });
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});
it("rejects changed workspace build policy before copying generated artifacts", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.project, "package.json"),
      manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.zyrk = { scripts: { default: "allow", allow: [], deny: [] } };
    await writeFile(file, JSON.stringify(manifest));
    await expect(f.deploy(path.join(f.root, "runtime"))).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});
it("exports selected local executable entries and excludes dev workspace packages", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.project, "packages/a/package.json"),
      manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.bin = { "a-cli": "cli.cjs" };
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(
      path.join(f.project, "packages/a/cli.cjs"),
      'console.log(require("./index.js").b.value)',
    );
    const out = path.join(f.root, "runtime");
    await f.deploy(out);
    await rmrfNoFollow(f.project);
    await rmrfNoFollow(f.store.root);
    expect(
      (
        await exec(path.join(out, "node_modules/.bin/a-cli"), [], {
          cwd: out,
          env: { PATH: process.env.PATH },
        })
      ).stdout.trim(),
    ).toBe("b-asset");
    await expect(
      readFile(path.join(out, "node_modules/dev/package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});

it("verifies shared registry payloads before workspace export and never masks corrupt input", async () => {
  const f = await fixture();
  try {
    const file = await realpath(
      path.join(f.project, "node_modules/pure/index.js"),
    );
    await chmod(file, 0o644);
    await writeFile(file, 'module.exports="corrupt";');
    await expect(f.deploy(path.join(f.root, "runtime"))).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});
it("rejects output inside a selected live package before inspecting or copying that source", async () => {
  const f = await fixture();
  try {
    // A non-runtime filename stops the old recursive copier before it can recurse
    // into its own staging tree; the output-boundary guard must reject first.
    await writeFile(
      path.join(f.project, "packages/a/.env"),
      "not selected for runtime",
    );
    await expect(
      f.deploy(path.join(f.project, "packages/a/runtime")),
    ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_ESCAPE" });
  } finally {
    await f.server.close();
    await rmrfNoFollow(f.root);
  }
});
it.each(["graphDigest", "candidate", "privateDir"])(
  "rejects changed workspace generation %s metadata",
  async (field) => {
    const f = await fixture();
    try {
      const file = path.join(
          f.project,
          "node_modules/.zyrk/install-state.json",
        ),
        state = JSON.parse(await readFile(file, "utf8"));
      if (field === "candidate")
        state.buildProfile.candidate = "unsupported-profile";
      else state[field] = "unsupported-generation";
      await writeFile(file, JSON.stringify(state));
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_STORE_CORRUPT" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
