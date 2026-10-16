import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDlx, splitDlxSpec } from "../src/dlx/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

let root: string;
let store: Store;
let registry: StubRegistry;
let client: RegistryClient;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-"));
  store = await Store.open({ root: path.join(root, "store"), create: true });
  registry = await startStubRegistry([
    {
      name: "lib",
      versions: [
        {
          version: "1.0.0",
          files: {
            "index.js": { data: 'module.exports = "lib-ok";\n' },
          },
        },
      ],
    },
    {
      name: "greet-tool",
      versions: [
        {
          version: "1.0.0",
          files: {
            "bin/greet.js": {
              data: 'const lib = require("lib");\nconsole.log(`tool says ${lib} ` + process.argv.slice(2).join(","));\n',
              mode: 0o755,
            },
          },
          deps: { lib: "^1.0.0" },
          bin: { "greet-tool": "./bin/greet.js" },
        },
        {
          version: "2.0.0",
          files: {
            "bin/greet.js": {
              data: 'console.log("v2 " + process.argv.slice(2).join(","));\n',
              mode: 0o755,
            },
          },
          bin: { "greet-tool": "./bin/greet.js" },
        },
      ],
      tags: { latest: "2.0.0" },
    },
    {
      name: "evil-tool",
      versions: [
        {
          version: "1.0.0",
          files: {
            "bin/evil.js": {
              data: 'require("node:fs").writeFileSync("PWNED", "x");\n',
              mode: 0o755,
            },
          },
          bin: { "evil-tool": "./bin/evil.js" },
          scripts: { postinstall: "node bin/evil.js" },
        },
      ],
    },
    {
      name: "nobin",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports = 1;\n" } },
        },
      ],
    },
    {
      name: "multibin",
      versions: [
        {
          version: "1.0.0",
          files: {
            "a.js": { data: 'console.log("a");\n' },
            "b.js": { data: 'console.log("b");\n' },
          },
          bin: { b: "./b.js", a: "./a.js" },
        },
      ],
    },
    {
      name: "failer",
      versions: [
        {
          version: "1.0.0",
          files: { "bin/fail.js": { data: "process.exit(3);\n", mode: 0o755 } },
          bin: { failer: "./bin/fail.js" },
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

function toolEnv(): NodeJS.ProcessEnv {
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
  return env;
}

describe("splitDlxSpec", () => {
  it("splits names from version parts", () => {
    expect(splitDlxSpec("greet-tool")).toEqual({
      name: "greet-tool",
      versionSpec: "",
    });
    expect(splitDlxSpec("greet-tool@^1.0.0")).toEqual({
      name: "greet-tool",
      versionSpec: "^1.0.0",
    });
    expect(splitDlxSpec("@scope/tool@beta")).toEqual({
      name: "@scope/tool",
      versionSpec: "beta",
    });
    expect(splitDlxSpec("alt@npm:real@2")).toEqual({
      name: "alt",
      versionSpec: "npm:real@2",
    });
  });

  it("rejects invalid specifiers", () => {
    expect(() => splitDlxSpec("")).toThrowError(/invalid tool specifier/);
  });
});

describe("runDlx", () => {
  it("resolves, fetches, realizes, and runs a tool with its dependencies", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      const result = await runDlx({
        store,
        registry: client,
        spec: "greet-tool@1.0.0",
        args: ["x", "y"],
        cwd: project,
        env: toolEnv(),
        capture: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("tool says lib-ok x,y\n");
      expect(result.name).toBe("greet-tool");
      expect(result.version).toBe("1.0.0");
      expect(result.reused).toBe(false);
      expect(await pathExists(result.envDir)).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("reuses shared realizations on the second run", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      const env = toolEnv();
      const first = await runDlx({
        store,
        registry: client,
        spec: "greet-tool@1.0.0",
        cwd: project,
        env,
        capture: true,
      });
      expect(first.reused).toBe(false);
      const second = await runDlx({
        store,
        registry: client,
        spec: "greet-tool@1.0.0",
        cwd: project,
        env,
        capture: true,
      });
      expect(second.exitCode).toBe(0);
      expect(second.reused).toBe(true);
      expect(second.stdout).toBe(first.stdout);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("resolves tags to their exact version", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      const result = await runDlx({
        store,
        registry: client,
        spec: "greet-tool",
        cwd: project,
        env: toolEnv(),
        capture: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.version).toBe("2.0.0");
      expect(result.stdout.startsWith("v2")).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("fails unknown versions without running anything", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      await expect(
        runDlx({
          store,
          registry: client,
          spec: "greet-tool@9.9.9",
          cwd: project,
          env: toolEnv(),
        }),
      ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("blocks scripted closures before anything executes", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      await expect(
        runDlx({
          store,
          registry: client,
          spec: "evil-tool",
          cwd: project,
          env: toolEnv(),
        }),
      ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
      expect(await pathExists(path.join(project, "PWNED"))).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("fails tools without a usable bin entry", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      await expect(
        runDlx({
          store,
          registry: client,
          spec: "nobin",
          cwd: project,
          env: toolEnv(),
        }),
      ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
      await expect(
        runDlx({
          store,
          registry: client,
          spec: "multibin",
          cwd: project,
          env: toolEnv(),
        }),
      ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("propagates the tool exit code and still cleans up", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      const result = await runDlx({
        store,
        registry: client,
        spec: "failer",
        cwd: project,
        env: toolEnv(),
        capture: true,
      });
      expect(result.exitCode).toBe(3);
      expect(await pathExists(result.envDir)).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("writes the tool output to a file through the working directory", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "zyrk-dlx-cwd-"));
    try {
      await writeFile(path.join(project, "marker.txt"), "cwd-ok\n");
      const result = await runDlx({
        store,
        registry: client,
        spec: "greet-tool@1.0.0",
        cwd: project,
        env: toolEnv(),
        capture: true,
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(project, "marker.txt"), "utf8")).toBe(
        "cwd-ok\n",
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
