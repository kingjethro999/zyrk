import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
