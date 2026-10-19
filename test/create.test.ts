import {
  mkdtemp,
  rm,
  readFile,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDlx } from "../src/dlx/run.ts";
import { nextTarget } from "../src/dlx/next.ts";
import { runCreate, starterSpecFor } from "../src/dlx/create.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

describe("starterSpecFor", () => {
  it.each([
    ["next-app", "create-next-app@*"],
    ["next-app@canary", "create-next-app@canary"],
    ["next-app@^5.0.0", "create-next-app@^5.0.0"],
    ["create-next-app", "create-next-app@*"],
    ["create-next-app@1.2.3", "create-next-app@1.2.3"],
    ["@scope/kit", "@scope/create-kit@*"],
    ["@scope/kit@beta", "@scope/create-kit@beta"],
    ["@scope/create-kit", "@scope/create-kit@*"],
    ["@scope", "@scope/create"],
    ["@scope@1.0.0", "@scope/create@1.0.0"],
  ])("maps %s to %s", (input, expected) => {
    expect(starterSpecFor(input)).toBe(expected);
  });

  it("rejects non-registry initializers", () => {
    expect(() => starterSpecFor("")).toThrowError(/unrecognized initializer/);
  });
});

describe("runCreate", () => {
  let root: string;
  let store: Store;
  let registry: StubRegistry;
  let client: RegistryClient;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zyrk-create-"));
    store = await Store.open({ root: path.join(root, "store"), create: true });
    registry = await startStubRegistry([
      {
        name: "create-next-app",
        versions: [
          {
            version: "16.4.2",
            bin: { "create-next-app": "bin.js" },
            files: {
              "template.ts": { data: "template" },
              "bin.js": {
                data: `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--abort')) process.exit(0);
if (args.includes('--fail')) process.exit(7);
if (args.includes('--help')) { console.log('help'); process.exit(0); }
if (!args.includes('--skip-install')) require('node:child_process').execFileSync('npm', ['install']);
const target = path.resolve(args.find(x => !x.startsWith('-')) || 'interactive-app');
if (args.includes('--replace-target')) { fs.renameSync(target, target + '-original'); fs.mkdirSync(target); }
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'template.ts'), path.join(target, 'next.config.ts'));
fs.chmodSync(path.join(target, 'next.config.ts'), fs.statSync(path.join(__dirname, 'template.ts')).mode);
fs.writeFileSync(path.join(target, 'next.config.ts'), 'rewritten');
fs.writeFileSync(path.join(target, 'package.json'), args.includes('--malformed') ? 'invalid' : JSON.stringify({ name: path.basename(target), dependencies: {next: '1.0.0'} }));
if (args.includes('--ambiguous')) { fs.mkdirSync('other-app'); fs.copyFileSync(path.join(target, 'package.json'), 'other-app/package.json'); }
`,
              },
            },
          },
        ],
      },
      {
        name: "next",
        versions: [
          {
            version: "1.0.0",
            files: { "index.js": { data: "module.exports = 'next';" } },
          },
        ],
      },
      {
        name: "create-template",
        versions: [
          {
            version: "1.0.0",
            deps: { "template-dependency": "1.0.0" },
            bin: { "create-template": "bin.js" },
            files: {
              "bin.js": {
                data: `const fs = require('node:fs');
const path = require('node:path');
const dependency = require('template-dependency');
if (process.argv.includes('--inspect')) {
  console.log(fs.readFileSync(path.join(__dirname, 'template.ts'), 'utf8'));
  console.log(fs.existsSync(path.join(path.dirname(require.resolve('template-dependency')), 'mutable')));
  console.log(fs.statSync(path.join(__dirname, 'template.ts')).mode & 0o222);
  process.exit(0);
}
dependency();
const target = path.join(process.cwd(), 'copied.ts');
fs.copyFileSync(path.join(__dirname, 'template.ts'), target);
fs.chmodSync(target, fs.statSync(path.join(__dirname, 'template.ts')).mode);
fs.writeFileSync(target, 'rewritten');
console.log(fs.statSync(path.join(__dirname, 'template.ts')).nlink);
`,
              },
              "template.ts": { data: "original" },
            },
          },
        ],
      },
      {
        name: "template-dependency",
        versions: [
          {
            version: "1.0.0",
            files: {
              "index.js": {
                data: `module.exports = () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'mutable'), 'private');`,
              },
            },
          },
        ],
      },
      {
        name: "create-greet",
        versions: [
          {
            version: "1.0.0",
            files: {
              "bin/new.js": {
                data: 'console.log("scaffold " + process.argv.slice(2).join(","));\n',
                mode: 0o755,
              },
            },
            bin: { "create-greet": "./bin/new.js" },
          },
        ],
      },
    ]);
    client = new RegistryClient({
      registry: registry.url,
      userAgent: "zyrk-test/0",
    });
  });

  afterEach(async () => {
    await registry.close();
    await rmrfNoFollow(root);
  });

  it.each(["14.2.0", "17.0.0", "16.4.2-canary.1"])(
    "rejects resolved unsupported Next version %s before execution",
    async (version) => {
      const unsupported = await startStubRegistry([
        {
          name: "create-next-app",
          tags: { legacy: version },
          versions: [
            {
              version,
              bin: { "create-next-app": "bin.js" },
              files: {
                "bin.js": {
                  data: "require('node:fs').writeFileSync('old-executed', 'unexpected');",
                },
              },
            },
          ],
        },
      ]);
      try {
        await expect(
          runCreate({
            store,
            registry: new RegistryClient({
              registry: unsupported.url,
              userAgent: "zyrk-test/0",
            }),
            input: "next-app@legacy",
            args: ["web"],
            cwd: root,
            capture: true,
          }),
        ).rejects.toMatchObject({
          code: "ZYRK_RESOLUTION_FAILED",
          detail: { version },
        });
        await expect(
          stat(path.join(root, "old-executed")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await unsupported.close();
      }
    },
  );

  it("runs Next generation without npm and installs dependencies natively", async () => {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const marker = path.join(root, "npm-invoked");
    await writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh\ntouch '${marker}'\nexit 99\n`,
      { mode: 0o755 },
    );
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app@16.4.2",
      args: ["web", "--yes"],
      cwd: root,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
      capture: true,
    });
    expect(result.exitCode).toBe(0);
    expect(
      await readFile(path.join(root, "web", "next.config.ts"), "utf8"),
    ).toBe("rewritten");
    expect(
      await readFile(
        path.join(root, "web", "node_modules", "next", "index.js"),
        "utf8",
      ),
    ).toContain("module.exports");
    expect(
      JSON.parse(
        await readFile(path.join(root, "web", "package-lock.json"), "utf8"),
      ),
    ).toHaveProperty("zyrk");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not install over an existing project manifest", async () => {
    const target = path.join(root, "existing");
    await mkdir(target);
    const original = JSON.stringify({
      name: "unrelated",
      dependencies: { next: "1.0.0" },
    });
    await writeFile(path.join(target, "package.json"), original);
    await expect(
      runCreate({
        store,
        registry: client,
        input: "next-app",
        args: ["existing", "--abort"],
        cwd: root,
        capture: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    expect(await readFile(path.join(target, "package.json"), "utf8")).toBe(
      original,
    );
    await expect(stat(path.join(target, "node_modules"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("rejects malformed generated manifests without installing", async () => {
    await expect(
      runCreate({
        store,
        registry: client,
        input: "next-app",
        args: ["web", "--malformed"],
        cwd: root,
        capture: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    expect(await readFile(path.join(root, "web", "package.json"), "utf8")).toBe(
      "invalid",
    );
    await expect(
      stat(path.join(root, "web", "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses ambiguous interactive targets and retains generated files", async () => {
    await expect(
      runCreate({
        store,
        registry: client,
        input: "next-app",
        args: ["--ambiguous"],
        cwd: root,
        capture: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    for (const target of ["interactive-app", "other-app"]) {
      expect(await stat(path.join(root, target, "package.json"))).toBeDefined();
      await expect(
        stat(path.join(root, target, "node_modules")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("propagates a failed initializer without installing", async () => {
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app",
      args: ["web", "--fail"],
      cwd: root,
      capture: true,
    });
    expect(result.exitCode).toBe(7);
    await expect(stat(path.join(root, "web"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to install when the initializer replaces the target directory", async () => {
    await mkdir(path.join(root, "web"));
    await expect(
      runCreate({
        store,
        registry: client,
        input: "next-app",
        args: ["web", "--replace-target"],
        cwd: root,
        capture: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    await expect(
      stat(path.join(root, "web", "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(path.join(root, "web", "package.json"))).toBeDefined();
  });

  it("accepts an existing empty directory while preserving its identity", async () => {
    const target = path.join(root, "web");
    await mkdir(target);
    const original = await stat(target);
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app",
      args: ["web"],
      cwd: root,
      capture: true,
    });
    expect(result.exitCode).toBe(0);
    expect((await stat(target)).ino).toBe(original.ino);
  });

  it("honors explicit Next --skip-install", async () => {
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app",
      args: ["web", "--skip-install"],
      cwd: root,
      capture: true,
    });
    expect(result.exitCode).toBe(0);
    await expect(
      stat(path.join(root, "web", "node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not trust a successful Next exit without a generated manifest", async () => {
    await expect(
      runCreate({
        store,
        registry: client,
        input: "next-app",
        args: ["web", "--abort"],
        cwd: root,
        capture: true,
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
  });

  it("discovers a newly created interactive Next target", async () => {
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app",
      args: [],
      cwd: root,
      capture: true,
    });
    expect(result.exitCode).toBe(0);
    expect(
      await stat(path.join(root, "interactive-app", "node_modules", "next")),
    ).toBeDefined();
  });

  it("passes informational Next commands through", async () => {
    const result = await runCreate({
      store,
      registry: client,
      input: "next-app",
      args: ["--help"],
      cwd: root,
      capture: true,
    });
    expect(result.stdout).toBe("help\n");
  });

  it("copies writable independent templates and keeps its whole closure private", async () => {
    const result = await runCreate({
      store,
      registry: client,
      input: "template",
      cwd: root,
      capture: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1\n");
    const shared = await runDlx({
      store,
      registry: client,
      spec: "create-template",
      args: ["--inspect"],
      cwd: root,
      capture: true,
    });
    expect(shared.stdout).toBe("original\nfalse\n0\n");
    expect(await readFile(path.join(root, "copied.ts"), "utf8")).toBe(
      "rewritten",
    );
    expect((await stat(path.join(root, "copied.ts"))).mode & 0o200).toBe(0o200);
    await expect(stat(result.envDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the starter package for a bare initializer", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-create-cwd-"));
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("ZYRK_") &&
            key !== "NODE_PATH" &&
            key !== "NODE_OPTIONS",
        ),
      ) as NodeJS.ProcessEnv;
      env.NO_PROXY = "127.0.0.1,localhost";
      env.no_proxy = "127.0.0.1,localhost";
      const result = await runCreate({
        store,
        registry: client,
        input: "greet",
        args: ["my-app"],
        cwd: project,
        env,
        capture: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.name).toBe("create-greet");
      expect(result.stdout).toBe("scaffold my-app\n");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("Next target parsing", () => {
  it.each([
    [["--example", "basic", "web"], "web"],
    [["--import-alias", "@/*", "--typescript", "web"], "web"],
    [["--example=basic", "--example-path=app", "web"], "web"],
    [["--", "web"], "web"],
    [["--yes"], undefined],
  ] as const)("finds the target in %j", (args, target) =>
    expect(nextTarget(args)).toBe(target),
  );
});
