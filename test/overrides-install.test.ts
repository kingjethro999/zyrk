import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
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
  root = await mkdtemp(path.join(tmpdir(), "zyrk-overrides-"));
  project = path.join(root, "app");
  await mkdir(project);
  server = await startStubRegistry([
    ...["p", "q"].map((name) => ({
      name,
      versions: [
        {
          version: "1.0.0",
          deps: { shared: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("shared");' } },
        },
      ],
    })),
    {
      name: "shared",
      versions: [
        {
          version: "1.0.0",
          deps: { leaf: "1.0.0", loop: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("leaf");' } },
        },
      ],
    },
    {
      name: "loop",
      versions: [
        {
          version: "1.0.0",
          deps: { shared: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("shared");' } },
        },
      ],
    },
    {
      name: "leaf",
      versions: ["1.0.0", "2.0.0"].map((version) => ({
        version,
        files: {
          "index.js": { data: `module.exports=${JSON.stringify(version)};` },
        },
      })),
    },
    ...["consumer-a", "consumer-b"].map((name) => ({
      name,
      versions: [
        {
          version: "1.0.0",
          deps: { wrapper: "1.0.0" },
          files: { "index.js": { data: 'module.exports=require("wrapper");' } },
        },
      ],
    })),
    {
      name: "wrapper",
      versions: [
        {
          version: "1.0.0",
          deps: { host: "1.0.0", plugin: "1.0.0" },
          files: {
            "index.js": {
              data: 'module.exports=[require("host"),require("plugin")];',
            },
          },
        },
      ],
    },
    {
      name: "host",
      versions: ["1.0.0", "1.1.0", "2.0.0"].map((version) => ({
        version,
        deps: { leaf: "1.0.0" },
        files: {
          "index.js": {
            data: `module.exports={version:${JSON.stringify(version)},leaf:require("leaf")};`,
          },
        },
      })),
    },
    {
      name: "plugin",
      versions: [
        {
          version: "1.0.0",
          peerDeps: { host: "^1.0.0" },
          files: { "index.js": { data: 'module.exports=require("host");' } },
        },
      ],
    },
    {
      name: "fork",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="fork";' } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
    retries: 0,
  });
  store = await Store.open({ root: path.join(root, "store"), create: true });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
it("runs isolated override descendants for identical parents, retains cycles, and reuses frozen offline", async () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { p: "1.0.0", q: "1.0.0" },
    overrides: {
      p: { shared: { leaf: "2.0.0" } },
      q: { shared: { leaf: "1.0.0" } },
    },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await installProject({ projectDir: project, store, registry });
  const code = 'console.log(require("p"),require("q"));';
  expect(
    (
      await exec(process.execPath, ["-e", code], { cwd: project })
    ).stdout.trim(),
  ).toBe("2.0.0 1.0.0");
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8");
  await installProject({
    projectDir: project,
    store,
    registry,
    frozen: true,
    offline: true,
  });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
  manifest.overrides.p.shared.leaf = "1.0.0";
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await expect(
    installProject({ projectDir: project, store, registry, frozen: true }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
  expect(
    (
      await exec(process.execPath, ["-e", code], { cwd: project })
    ).stdout.trim(),
  ).toBe("2.0.0 1.0.0");
});
it("applies root override contexts to workspaces while ignoring child override policies", async () => {
  await mkdir(path.join(project, "packages/member"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { member: "*" },
      overrides: {
        p: { shared: { leaf: "2.0.0" } },
        q: { shared: { leaf: "1.0.0" } },
      },
    }),
  );
  await writeFile(
    path.join(project, "packages/member/package.json"),
    JSON.stringify({
      name: "member",
      version: "1.0.0",
      dependencies: { p: "1.0.0", q: "1.0.0" },
      overrides: { leaf: "npm:fork@1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/member/index.js"),
    'module.exports=[require("p"),require("q")];',
  );
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("member").join(" "))'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("2.0.0 1.0.0");
  await installProject({
    projectDir: project,
    store,
    registry,
    frozen: true,
    offline: true,
  });
  const child = JSON.parse(
    await readFile(path.join(project, "packages/member/package.json"), "utf8"),
  );
  child.overrides.leaf = "2.0.0";
  await writeFile(
    path.join(project, "packages/member/package.json"),
    JSON.stringify(child),
  );
  await installProject({
    projectDir: project,
    store,
    registry,
    frozen: true,
    offline: true,
  });
});
it("adopts a pinned npm workspace graph with different override contexts", async () => {
  await mkdir(path.join(project, "packages/member"), { recursive: true });
  const rootManifest = {
    name: "app",
    version: "1.0.0",
    workspaces: ["packages/*"],
    dependencies: { member: "*" },
    overrides: {
      p: { shared: { leaf: "2.0.0" } },
      q: { shared: { leaf: "1.0.0" } },
    },
  };
  const member = {
    name: "member",
    version: "1.0.0",
    dependencies: { p: "1.0.0", q: "1.0.0" },
  };
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify(rootManifest),
  );
  await writeFile(
    path.join(project, "packages/member/package.json"),
    JSON.stringify(member),
  );
  await writeFile(
    path.join(project, "packages/member/index.js"),
    'module.exports=[require("p"),require("q")];',
  );
  const locked = async (name: string, version: string) => {
    const entry = (await registry.packument(name)).versions[version]!;
    return {
      name,
      version,
      resolved: entry.dist.tarball,
      integrity: entry.dist.integrity,
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    };
  };
  const packages: Record<string, unknown> = {
    "": rootManifest,
    "packages/member": member,
    "node_modules/member": { link: true, resolved: "packages/member" },
  };
  for (const parent of ["p", "q"]) {
    const base = `node_modules/${parent}`;
    packages[base] = await locked(parent, "1.0.0");
    packages[`${base}/node_modules/shared`] = await locked("shared", "1.0.0");
    packages[`${base}/node_modules/shared/node_modules/leaf`] = await locked(
      "leaf",
      parent === "p" ? "2.0.0" : "1.0.0",
    );
    packages[`${base}/node_modules/shared/node_modules/loop`] = await locked(
      "loop",
      "1.0.0",
    );
  }
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
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
        ["-e", 'console.log(require("member").join(" "))'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("2.0.0 1.0.0");
  await installProject({
    projectDir: project,
    store,
    registry,
    frozen: true,
    offline: true,
  });
});
it("applies a registry alias fork and overridden peer range without splitting its host singleton", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { p: "1.0.0", wrapper: "1.0.0" },
      overrides: {
        p: { shared: { ".": "npm:fork@1.0.0" } },
        wrapper: { host: "2.0.0" },
      },
    }),
  );
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        [
          "-e",
          'const [a,b]=require("wrapper");if(a!==b)throw Error("split host");console.log(require("p"),a.version);',
        ],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("fork 2.0.0");
  await installProject({
    projectDir: project,
    store,
    registry,
    frozen: true,
    offline: true,
  });
});
it("preserves an installed generation when a direct override is invalid", async () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { p: "1.0.0" },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await installProject({ projectDir: project, store, registry });
  const before = await readFile(
      path.join(project, "package-lock.json"),
      "utf8",
    ),
    target = await realpath(path.join(project, "node_modules"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ ...manifest, overrides: { p: "^1.0.0" } }),
  );
  await expect(
    installProject({ projectDir: project, store, registry }),
  ).rejects.toMatchObject({ code: "ZYRK_MANIFEST_INVALID" });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    before,
  );
  expect(await realpath(path.join(project, "node_modules"))).toBe(target);
});
it("resolves transitive dollar references from direct declarations", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { p: "1.0.0", host: "2.0.0" },
      overrides: { leaf: "$host", host: "$host" },
    }),
  );
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("p"),require("host").version)'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("2.0.0 2.0.0");
});
it("carries scoped root overrides through a chain of live workspace members", async () => {
  await mkdir(path.join(project, "packages/a"), { recursive: true });
  await mkdir(path.join(project, "packages/b"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { a: "*" },
      overrides: { a: { b: { p: { shared: { leaf: "2.0.0" } } } } },
    }),
  );
  await writeFile(
    path.join(project, "packages/a/package.json"),
    JSON.stringify({ name: "a", version: "1.0.0", dependencies: { b: "*" } }),
  );
  await writeFile(
    path.join(project, "packages/a/index.js"),
    'module.exports=require("b");',
  );
  await writeFile(
    path.join(project, "packages/b/package.json"),
    JSON.stringify({
      name: "b",
      version: "1.0.0",
      dependencies: { p: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/b/index.js"),
    'module.exports=require("p");',
  );
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("a"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("2.0.0");
});
it("refines live workspace scopes reached through registry packages and peers", async () => {
  await mkdir(path.join(project, "packages/host"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { wrapper: "1.0.0" },
      overrides: { wrapper: { host: { p: { shared: { leaf: "2.0.0" } } } } },
    }),
  );
  await writeFile(
    path.join(project, "packages/host/package.json"),
    JSON.stringify({
      name: "host",
      version: "1.0.0",
      dependencies: { p: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(project, "packages/host/index.js"),
    'module.exports={leaf:require("p")};',
  );
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        [
          "-e",
          'const [a,b]=require("wrapper");if(a!==b)throw Error("split");console.log(a.leaf);',
        ],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("2.0.0");
});
it("rejects incompatible scopes for one live importer before project mutation", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      workspaces: ["packages/*"],
      dependencies: { a: "*", c: "*" },
      overrides: { a: { b: { p: "1.0.0" } }, c: { b: { p: "2.0.0" } } },
    }),
  );
  for (const name of ["a", "b", "c"]) {
    await mkdir(path.join(project, "packages", name), { recursive: true });
    await writeFile(
      path.join(project, "packages", name, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        dependencies: name === "b" ? { p: "1.0.0" } : { b: "*" },
      }),
    );
  }
  await expect(
    installProject({ projectDir: project, store, registry }),
  ).rejects.toThrow(/live workspace.*override contexts/);
  await expect(
    realpath(path.join(project, ".zyrk-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(path.join(project, "package-lock.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains a compatible root pin when its identical override is a dollar reference", async () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { host: "1.0.0" },
    overrides: { host: "$host" },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await installProject({ projectDir: project, store, registry });
  manifest.dependencies.host = "^1.0.0";
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(
        process.execPath,
        ["-e", 'console.log(require("host").version)'],
        { cwd: project },
      )
    ).stdout.trim(),
  ).toBe("1.0.0");
});
it("rejects unsupported override sources without exposing secrets or creating project state", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { p: "1.0.0" },
      overrides: { leaf: "https://user:hidden-secret@example.com/leaf.tgz" },
    }),
  );
  const failure = await installProject({
    projectDir: project,
    store,
    registry,
  }).catch((e) => e);
  expect(failure.code).toBe("ZYRK_MANIFEST_INVALID");
  expect(failure.message).not.toContain("hidden-secret");
  await expect(
    realpath(path.join(project, ".zyrk-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves a contradictory npm lock before creating override import state", async () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { p: "1.0.0" },
    overrides: { p: { shared: { leaf: "2.0.0" } } },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  const packages: Record<string, unknown> = { "": manifest };
  for (const name of ["p", "shared", "loop", "leaf"]) {
    const entry = (await registry.packument(name)).versions["1.0.0"]!;
    packages[`node_modules/${name}`] = {
      name,
      version: entry.version,
      resolved: entry.dist.tarball,
      integrity: entry.dist.integrity,
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    };
  }
  const lock = JSON.stringify({ lockfileVersion: 3, packages });
  await writeFile(path.join(project, "package-lock.json"), lock);
  await expect(
    installProject({ projectDir: project, store, registry, importNpm: true }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
  await expect(
    realpath(path.join(project, ".zyrk-local")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("splits peers bound to equal-version hosts with different overridden descendants", async () => {
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "consumer-a": "1.0.0", "consumer-b": "1.0.0" },
      overrides: {
        "consumer-a": { wrapper: { host: { leaf: "2.0.0" } } },
        "consumer-b": { wrapper: { host: { leaf: "1.0.0" } } },
        plugin: "1.0.0",
      },
    }),
  );
  await installProject({ projectDir: project, store, registry });
  const code =
    'const [a,ap]=require("consumer-a"),[b,bp]=require("consumer-b");if(a!==ap||b!==bp||a===b)throw Error("split");console.log(a.leaf,b.leaf);';
  expect(
    (
      await exec(process.execPath, ["-e", code], { cwd: project })
    ).stdout.trim(),
  ).toBe("2.0.0 1.0.0");
});
it("rejects frozen reuse when overlapping override rules are reordered", async () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { p: "1.0.0" },
    overrides: { leaf: "1.0.0", "leaf@^1": "2.0.0" },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await installProject({ projectDir: project, store, registry });
  const lock = await readFile(path.join(project, "package-lock.json"), "utf8");
  manifest.overrides = { "leaf@^1": "2.0.0", leaf: "1.0.0" };
  await writeFile(path.join(project, "package.json"), JSON.stringify(manifest));
  await expect(
    installProject({ projectDir: project, store, registry, frozen: true }),
  ).rejects.toMatchObject({ code: "ZYRK_LOCK_MISMATCH" });
  expect(await readFile(path.join(project, "package-lock.json"), "utf8")).toBe(
    lock,
  );
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("p"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("1.0.0");
  await installProject({ projectDir: project, store, registry });
  expect(
    (
      await exec(process.execPath, ["-e", 'console.log(require("p"))'], {
        cwd: project,
      })
    ).stdout.trim(),
  ).toBe("2.0.0");
});
