import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type ToolEnvironment } from "../src/cli/main.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

let root: string;
let tools: ToolEnvironment;
let registry: StubRegistry;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nexu-cli-tools-"));
  const store = await Store.open({
    root: path.join(root, "store"),
    create: true,
  });
  registry = await startStubRegistry([
    {
      name: "tiny-tool",
      versions: [
        {
          version: "1.0.0",
          files: {
            "bin/tiny.js": { data: 'console.log("tiny-ok");\n', mode: 0o755 },
          },
          bin: { "tiny-tool": "./bin/tiny.js" },
        },
      ],
    },
    {
      name: "create-tiny",
      versions: [
        {
          version: "1.0.0",
          files: {
            "bin/new.js": {
              data: 'console.log("tiny-scaffold");\n',
              mode: 0o755,
            },
          },
          bin: { "create-tiny": "./bin/new.js" },
        },
      ],
    },
    {
      name: "quitter",
      versions: [
        {
          version: "1.0.0",
          files: { "bin/quit.js": { data: "process.exit(5);\n", mode: 0o755 } },
          bin: { quitter: "./bin/quit.js" },
        },
      ],
    },
  ]);
  tools = {
    store,
    registry: new RegistryClient({
      registry: registry.url,
      userAgent: "nexu-test/0",
    }),
  };
});

afterEach(async () => {
  await registry.close();
  await rmrfNoFollow(root);
});

function streams(): {
  out: string[];
  errOut: string[];
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
} {
  const out: string[] = [];
  const errOut: string[] = [];
  return {
    out,
    errOut,
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => errOut.push(chunk) },
  };
}

function toolEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("NEXU_") &&
        key !== "NODE_PATH" &&
        key !== "NODE_OPTIONS",
    ),
  ) as NodeJS.ProcessEnv;
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = "127.0.0.1,localhost";
  return env;
}

describe("runCli with tool commands", () => {
  it("runs dlx tools and returns their exit code", async () => {
    const { out, errOut, stdout, stderr } = streams();
    const code = await runCli({
      argv: ["dlx", "tiny-tool"],
      env: toolEnv(),
      stdout,
      stderr,
      cwd: root,
      readVersion: () => "9.9.9-test",
      tools: async () => tools,
    });
    expect(code).toBe(0);
    expect(out.join("")).toBe("");
    expect(errOut.join("")).toBe("");
  });

  it("propagates nonzero tool exit codes", async () => {
    const { stdout, stderr } = streams();
    const code = await runCli({
      argv: ["dlx", "quitter"],
      env: toolEnv(),
      stdout,
      stderr,
      cwd: root,
      readVersion: () => "9.9.9-test",
      tools: async () => tools,
    });
    expect(code).toBe(5);
  });

  it("routes create through the initializer mapping", async () => {
    const { stdout, stderr } = streams();
    const code = await runCli({
      argv: ["create", "tiny"],
      env: toolEnv(),
      stdout,
      stderr,
      cwd: root,
      readVersion: () => "9.9.9-test",
      tools: async () => tools,
    });
    expect(code).toBe(0);
  });

  it("requires a specifier for dlx and create", async () => {
    for (const command of ["dlx", "create"]) {
      const { errOut, stdout, stderr } = streams();
      const code = await runCli({
        argv: [command],
        env: toolEnv(),
        stdout,
        stderr,
        cwd: root,
        readVersion: () => "9.9.9-test",
        tools: async () => tools,
      });
      expect(code).toBe(2);
      expect(errOut.join("")).toContain("NEXU_USAGE");
    }
  });

  it("rejects --json for tool commands", async () => {
    const { out, errOut, stdout, stderr } = streams();
    const code = await runCli({
      argv: ["--json", "dlx", "tiny-tool"],
      env: toolEnv(),
      stdout,
      stderr,
      cwd: root,
      readVersion: () => "9.9.9-test",
      tools: async () => tools,
    });
    expect(code).toBe(2);
    expect(errOut.join("")).toBe("");
    expect(JSON.parse(out.join(""))).toMatchObject({
      schemaVersion: 1,
      status: "error",
      code: "NEXU_USAGE",
    });
  });

  it("reports tool failures without claiming success", async () => {
    const { errOut, stdout, stderr } = streams();
    const code = await runCli({
      argv: ["dlx", "ghost-tool"],
      env: toolEnv(),
      stdout,
      stderr,
      cwd: root,
      readVersion: () => "9.9.9-test",
      tools: async () => tools,
    });
    expect(code).not.toBe(0);
    expect(errOut.join("")).toContain("NEXU_RESOLUTION_FAILED");
  });
});
