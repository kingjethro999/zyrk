import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { runCli } from "../src/cli/main.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow, pathExists } from "../src/util/fsx.ts";
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
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-install-"));
  project = path.join(root, "app");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          deps: { beta: "1.0.0" },
          files: {
            "index.js": { data: 'module.exports="alpha:"+require("beta");' },
          },
        },
      ],
    },
    {
      name: "beta",
      versions: [
        {
          version: "1.0.0",
          files: {
            "index.js": { data: 'module.exports="one";' },
            "cli.js": {
              data: '#!/usr/bin/env node\nconsole.log("beta-cli");',
              mode: 0o755,
            },
          },
          bin: { beta: "cli.js" },
        },
        {
          version: "2.0.0",
          files: { "index.js": { data: 'module.exports="two";' } },
        },
      ],
    },
    {
      name: "built",
      versions: [
        {
          version: "1.0.0",
          scripts: {
            postinstall: "node -e \"require('fs').writeFileSync('ran','yes')\"",
          },
          files: { "index.js": { data: 'module.exports="unbuilt";' } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "zyrk-test/0",
    retries: 0,
  });
  await manifest({ dependencies: { alpha: "1.0.0" } });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
async function manifest(fields: Record<string, unknown>, dir = project) {
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", ...fields }),
  );
}
function install(extra: Partial<Parameters<typeof installProject>[0]> = {}) {
  return installProject({ projectDir: project, store, registry, ...extra });
}
async function lockText() {
  return readFile(path.join(project, "package-lock.json"), "utf8");
}
async function evaluate(dir: string, source: string) {
  return (
    await exec(process.execPath, ["-e", source], { cwd: dir })
  ).stdout.trim();
}

it("installs the transitive shared graph and ordinary CJS/ESM imports", async () => {
  const result = await install();
  expect(result.readiness).toBe("ready");
  expect(result.packages).toBe(2);
  expect(
    (await lstat(path.join(project, "node_modules/alpha"))).isSymbolicLink(),
  ).toBe(true);
  expect(await evaluate(project, 'console.log(require("alpha"))')).toBe(
    "alpha:one",
  );
  expect(
    await evaluate(project, 'import("alpha").then(x=>console.log(x.default))'),
  ).toBe("alpha:one");
  expect(await pathExists(path.join(project, "node_modules/beta"))).toBe(false);
  const doc = JSON.parse(await lockText());
  expect(doc.zyrk.roots["."]).toEqual({ alpha: "alpha@1.0.0" });
  expect(doc.packages["node_modules/alpha/node_modules/beta"].version).toBe(
    "1.0.0",
  );
});
it("shares exact realizations across projects and isolates other versions", async () => {
  await install();
  const second = path.join(root, "second");
  await mkdir(second);
  await manifest({ dependencies: { alpha: "1.0.0", beta: "2.0.0" } }, second);
  await install({ projectDir: second });
  expect(await realpath(path.join(project, "node_modules/alpha"))).toBe(
    await realpath(path.join(second, "node_modules/alpha")),
  );
  expect(
    await evaluate(second, 'console.log(require("alpha"),require("beta"))'),
  ).toBe("alpha:one two");
  expect(await evaluate(project, 'console.log(require("alpha"))')).toBe(
    "alpha:one",
  );
});
it("reinstalls a locked closure offline with a byte-stable lock", async () => {
  await manifest({ dependencies: { beta: "^1.0.0" } });
  await install();
  const before = await lockText();
  await server.close();
  server.close = async () => {};
  await rmrfNoFollow(path.join(project, "node_modules"));
  await install({ offline: true, frozen: true });
  expect(await lockText()).toBe(before);
  expect(await evaluate(project, 'console.log(require("beta"))')).toBe("one");
});
it("preserves a compatible locked version when other manifest inputs change", async () => {
  await manifest({ dependencies: { beta: "1.0.0" } });
  await install();
  await manifest({ dependencies: { beta: "*" } });
  await install();
  expect(await evaluate(project, 'console.log(require("beta"))')).toBe("one");
  await install();
  expect(await evaluate(project, 'console.log(require("beta"))')).toBe("one");
});
it("rejects frozen drift and missing offline inputs before changing the active graph", async () => {
  await install();
  const before = await lockText();
  await manifest({ dependencies: { beta: "2.0.0" } });
  await expect(install({ frozen: true })).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  await expect(install({ offline: true })).rejects.toMatchObject({
    code: "ZYRK_OFFLINE_MISSING",
  });
  expect(await lockText()).toBe(before);
  expect(await evaluate(project, 'console.log(require("alpha"))')).toBe(
    "alpha:one",
  );
});
it("rejects dependency scripts without changing the prior lock or projection", async () => {
  await install();
  const before = await lockText();
  await manifest({ dependencies: { built: "1.0.0" } });
  await expect(install()).rejects.toMatchObject({
    code: "ZYRK_SCRIPT_BLOCKED",
  });
  expect(await lockText()).toBe(before);
  expect(await evaluate(project, 'console.log(require("alpha"))')).toBe(
    "alpha:one",
  );
});
it("marks explicit script skipping as intentionally unbuilt and never runs root hooks", async () => {
  await manifest({
    dependencies: { built: "1.0.0" },
    scripts: { postinstall: "touch root-ran" },
  });
  const result = await install({ ignoreScripts: true });
  expect(result.readiness).toBe("intentionally-unbuilt");
  expect(result.warnings.join(" ")).toContain("postinstall");
  expect(await pathExists(path.join(project, "root-ran"))).toBe(false);
  expect(await pathExists(path.join(project, "node_modules/built/ran"))).toBe(
    false,
  );
  expect(
    JSON.parse(
      await readFile(
        path.join(project, "node_modules/.zyrk/install-state.json"),
        "utf8",
      ),
    ).readiness,
  ).toBe("intentionally-unbuilt");
});
it("adds requested packages transactionally and exposes declared binaries", async () => {
  const result = await install({ specs: ["beta@1.0.0"], saveDev: true });
  expect(result.readiness).toBe("ready");
  expect(
    JSON.parse(await readFile(path.join(project, "package.json"), "utf8"))
      .devDependencies.beta,
  ).toBe("^1.0.0");
  expect(
    (
      await exec(path.join(project, "node_modules/.bin/beta"), [], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("beta-cli");
  const before = await readFile(path.join(project, "package.json"), "utf8");
  await expect(install({ specs: ["built@1.0.0"] })).rejects.toMatchObject({
    code: "ZYRK_SCRIPT_BLOCKED",
  });
  expect(await readFile(path.join(project, "package.json"), "utf8")).toBe(
    before,
  );
});
it("installs aliases, scoped names, and dev dependencies without hoisting transitives", async () => {
  await manifest({
    dependencies: { alternate: "npm:beta@1.0.0" },
    devDependencies: { alpha: "1.0.0" },
  });
  await install();
  expect(
    await evaluate(
      project,
      'console.log(require("alternate"),require("alpha"))',
    ),
  ).toBe("one alpha:one");
});
it("omits dev roots without losing them from the full lock", async () => {
  await manifest({
    dependencies: { beta: "1.0.0" },
    devDependencies: { alpha: "1.0.0" },
  });
  await install({ omitDev: true });
  expect(await pathExists(path.join(project, "node_modules/alpha"))).toBe(
    false,
  );
  expect(JSON.parse(await lockText()).zyrk.roots["."].alpha).toBeDefined();
});
it("writes lockfile-only without publishing a projection or executing scripts", async () => {
  await manifest({ dependencies: { built: "1.0.0" } });
  const result = await install({ lockfileOnly: true });
  expect(result.readiness).toBe("lockfile-only");
  expect(await pathExists(path.join(project, "node_modules"))).toBe(false);
  expect(JSON.parse(await lockText()).zyrk.nodes["built@1.0.0"]).toBeDefined();
});
it("rejects unsafe locks and policy while supporting discovered workspace roots", async () => {
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: {} }),
  );
  await expect(install()).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
  await rmrfNoFollow(path.join(project, "package-lock.json"));
  await manifest({ workspaces: ["packages/*"] });
  expect((await install()).readiness).toBe("ready");
  expect(JSON.parse(await lockText()).zyrk.version).toBe(2);
  await manifest({ zyrk: { scripts: { default: "allow-all" } } });
  await expect(install()).rejects.toMatchObject({ code: "ZYRK_POLICY_DENIED" });
});
it("routes install and i through the CLI with matching human/JSON readiness", async () => {
  for (const args of [["install"], ["i", "--json", "--frozen-lockfile"]]) {
    let out = "",
      err = "";
    const code = await runCli({
      argv: args,
      env: {},
      cwd: project,
      tools: async () => ({ store, registry }),
      stdout: { write: (x) => (out += x) },
      stderr: { write: (x) => (err += x) },
    });
    expect(code).toBe(0);
    expect(err).toBe("");
    if (args.includes("--json"))
      expect(JSON.parse(out)).toMatchObject({
        status: "ok",
        readiness: "ready",
        packages: 2,
      });
    else expect(out).toContain("Installed");
  }
});

it("adopts npm exact selections without following a newer registry version", async () => {
  await manifest({ dependencies: { beta: "1.0.0" } });
  await install();
  const doc = JSON.parse(await lockText());
  delete doc.zyrk;
  doc.packages[""].dependencies.beta = "*";
  await manifest({ dependencies: { beta: "*" } });
  await writeFile(path.join(project, "package-lock.json"), JSON.stringify(doc));
  await install();
  expect(await evaluate(project, 'console.log(require("beta"))')).toBe("one");
  await install({ frozen: true, offline: true });
  expect(await evaluate(project, 'console.log(require("beta"))')).toBe("one");
});
it("refuses corrupted shared payloads before republishing the project", async () => {
  await install();
  const before = await lockText();
  const { chmod } = await import("node:fs/promises");
  const file = path.join(project, "node_modules/alpha/index.js");
  await chmod(file, 0o644);
  await writeFile(file, "corrupt");
  await expect(install({ frozen: true, offline: true })).rejects.toMatchObject({
    code: "ZYRK_STORE_CORRUPT",
  });
  expect(await lockText()).toBe(before);
});
it("rejects hostile lock paths and credential URLs without creating outside files", async () => {
  await install();
  const original = JSON.parse(await lockText());
  for (const tamper of [
    (doc: typeof original) => {
      doc.zyrk.nodes["alpha@1.0.0"].source = "../../outside";
    },
    (doc: typeof original) => {
      doc.zyrk.nodes["alpha@1.0.0"].tarball =
        "https://user:secret@example.com/pkg.tgz";
    },
    (doc: typeof original) => {
      doc.zyrk.roots["."] = { "../outside": "alpha@1.0.0" };
    },
  ]) {
    const doc = structuredClone(original);
    tamper(doc);
    await writeFile(
      path.join(project, "package-lock.json"),
      JSON.stringify(doc),
    );
    await expect(
      install({ frozen: true, offline: true }),
    ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
    expect(await pathExists(path.join(root, "outside"))).toBe(false);
  }
});
it("serializes concurrent installs of one project and retains a complete result", async () => {
  await Promise.all([install(), install()]);
  expect(await evaluate(project, 'console.log(require("alpha"))')).toBe(
    "alpha:one",
  );
  await install({ offline: true, frozen: true });
});
