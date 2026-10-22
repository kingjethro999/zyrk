/** Optional Linux toolchain gate; ordinary zyrk installation needs no compiler. */
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  realpath,
  stat,
  readFile,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
const compiler =
  process.platform === "linux" &&
  spawnSync("cc", ["--version"], { stdio: "ignore", timeout: 2000 }).status ===
    0;
const source = `#include <stdint.h>
typedef void* napi_env;
typedef void* napi_value;
extern int napi_create_int32(napi_env, int32_t, napi_value*);
extern int napi_set_named_property(napi_env, napi_value, const char*, napi_value);
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
 napi_value answer; if (napi_create_int32(env, 42, &answer)) return exports;
 napi_set_named_property(env, exports, "answer", answer); return exports;
}
`;
it.skipIf(!compiler)(
  "compiles and loads an approved N-API addon in a new private generation",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zyrk-native-build-"));
    const project = path.join(root, "project");
    await mkdir(project);
    const server = await startStubRegistry([
      {
        name: "native-fixture",
        versions: [
          {
            version: "1.0.0",
            scripts: { install: "cc -shared -fPIC addon.c -o addon.node" },
            files: {
              "addon.c": { data: source },
              "index.js": { data: 'module.exports=require("./addon.node");' },
            },
          },
        ],
      },
    ]);
    try {
      const store = await Store.open({
        root: path.join(root, "store"),
        create: true,
      });
      const registry = new RegistryClient({
        registry: server.url,
        userAgent: "native-smoke",
      });
      await writeFile(
        path.join(project, "package.json"),
        JSON.stringify({ dependencies: { "native-fixture": "1.0.0" } }),
      );
      const install = (
        extra: Partial<Parameters<typeof installProject>[0]> = {},
      ) => installProject({ projectDir: project, store, registry, ...extra });
      expect((await install()).readiness).toBe("intentionally-unbuilt");
      await install({ reviewBuilds: true, approveBuilds: ["native-fixture"] });
      await install();
      const first = await realpath(
        path.join(project, "node_modules/native-fixture"),
      );
      expect(first).toContain(".zyrk-local/generations/");
      expect((await stat(path.join(first, "addon.node"))).nlink).toBe(1);
      expect(await readFile(path.join(first, "addon.c"), "utf8")).toBe(source);
      expect(
        (
          await exec(
            process.execPath,
            ["-e", 'console.log(require("native-fixture").answer)'],
            { cwd: project },
          )
        ).stdout.trim(),
      ).toBe("42");
      await install({ frozen: true, offline: true, rebuild: true });
      expect(
        await realpath(path.join(project, "node_modules/native-fixture")),
      ).not.toBe(first);
      expect(
        (
          await exec(
            process.execPath,
            ["-e", 'console.log(require("native-fixture").answer)'],
            { cwd: project },
          )
        ).stdout.trim(),
      ).toBe("42");
    } finally {
      await server.close();
      await rmrfNoFollow(root);
    }
  },
);
