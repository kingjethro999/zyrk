/** Native export is a narrowly validated ELF N-API recipe; no compiler is needed by zyrk. */
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  open,
} from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { it, expect, vi } from "vitest";
import { installProject } from "../src/install/run.ts";
import { runDeployCommand } from "../src/commands/deploy.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
const exec = promisify(execFile);
const compiler =
  process.platform === "linux" &&
  process.arch === "x64" &&
  spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0;
const source = `#include <stdint.h>
typedef void* napi_env; typedef void* napi_value;
extern int napi_create_int32(napi_env,int32_t,napi_value*);
extern int napi_set_named_property(napi_env,napi_value,const char*,napi_value);
__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env,napi_value exports){napi_value value;napi_create_int32(env,42,&value);napi_set_named_property(env,exports,"answer",value);return exports;}
`;
async function fixture(extra = "") {
  const root = await mkdtemp(path.join(tmpdir(), "zyrk-native-export-")),
    project = path.join(root, "app");
  await mkdir(project);
  const server = await startStubRegistry([
    {
      name: "addon",
      versions: [
        {
          version: "1.0.0",
          scripts: {
            install:
              "cc -shared -fPIC -fno-stack-protector -nostdlib addon.c -o addon.node",
          },
          files: {
            "addon.c": { data: source + extra },
            "index.js": { data: 'module.exports=require("./addon.node");' },
          },
        },
      ],
    },
  ]);
  const store = await Store.open({
      root: path.join(root, "store"),
      create: true,
    }),
    registry = new RegistryClient({
      registry: server.url,
      userAgent: "test",
      retries: 0,
    });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { addon: "1.0.0" }, files: ["app.cjs"] }),
  );
  await writeFile(
    path.join(project, "app.cjs"),
    'console.log(require("addon").answer)',
  );
  await installProject({
    projectDir: project,
    store,
    registry,
    reviewBuilds: true,
    approveBuilds: ["addon"],
  });
  await installProject({ projectDir: project, store, registry });
  const deploy = (out: string) =>
    runDeployCommand({
      command: "deploy",
      cwd: project,
      env: { ...process.env, ZYRK_STORE_DIR: store.root },
      args: ["--out", out, "--entry", "app.cjs"],
      stdout: { write() {} },
      stderr: { write() {} },
    });
  return { root, project, store, server, deploy };
}
it.skipIf(!compiler)(
  "exports compiled position independent N-API bytes and runs after deleting the host project and store",
  async () => {
    const f = await fixture();
    try {
      const native = await realpath(
          path.join(f.project, "node_modules/addon/addon.node"),
        ),
        before = await readFile(native),
        out = path.join(f.root, "runtime");
      await f.deploy(out);
      expect(await readFile(native)).toEqual(before);
      expect(
        await readFile(path.join(out, "node_modules/addon/addon.node")),
      ).toEqual(before);
      await rmrfNoFollow(f.project);
      await rmrfNoFollow(f.store.root);
      expect(
        (
          await exec(process.execPath, ["app.cjs"], {
            cwd: out,
            env: { PATH: process.env.PATH },
          })
        ).stdout.trim(),
      ).toBe("42");
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
it.skipIf(!compiler)(
  "rejects native artifacts after ABI/profile drift",
  async () => {
    const f = await fixture();
    try {
      const file = path.join(
          f.project,
          "node_modules/.zyrk/install-state.json",
        ),
        state = JSON.parse(await readFile(file, "utf8"));
      state.buildProfile.abi = "0";
      await writeFile(file, JSON.stringify(state));
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_PLATFORM_UNSUPPORTED" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
it.skipIf(!compiler)(
  "rejects a native artifact that embeds its absolute private build path",
  async () => {
    const f = await fixture("const char* host_path=__FILE__;");
    try {
      const directory = await realpath(
        path.join(f.project, "node_modules/addon"),
      );
      await exec("cc", [
        "-shared",
        "-fPIC",
        "-fno-stack-protector",
        "-nostdlib",
        path.join(directory, "addon.c"),
        "-o",
        path.join(directory, "addon.node"),
      ]);
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
it.skipIf(!compiler)(
  "rejects ELF native addons with unvalidated external libraries",
  async () => {
    const f = await fixture();
    try {
      const directory = await realpath(
        path.join(f.project, "node_modules/addon"),
      );
      await exec(
        "cc",
        [
          "-shared",
          "-fPIC",
          "-fno-stack-protector",
          "-nostdlib",
          "addon.c",
          "-Wl,--no-as-needed",
          "-lc",
          "-o",
          "addon.node",
        ],
        { cwd: directory },
      );
      expect(
        (await readFile(path.join(directory, "addon.node"))).includes(
          Buffer.from("libc.so.6"),
        ),
      ).toBe(true);
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);

it.skipIf(!compiler)(
  "rejects native addons that embed an undeclared external cache path",
  async () => {
    const f = await fixture(
      'const char* external_cache="/tmp/undeclared-native-cache/output.dat";',
    );
    try {
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
it.skipIf(!compiler)(
  "rejects unvalidated N-API import symbols instead of publishing an unloadable addon",
  async () => {
    const f = await fixture(
      "extern void napi_unsupported_future_symbol(void); void unknown(){napi_unsupported_future_symbol();}",
    );
    try {
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
it.skipIf(!compiler).each(["offset", "address", "symbols"])(
  "rejects native loader %s metadata that diverges from inspected ELF sections",
  async (field) => {
    const f = await fixture();
    try {
      const native = await realpath(
        path.join(f.project, "node_modules/addon/addon.node"),
      );
      const bytes = await readFile(native);
      const table = Number(bytes.readBigUInt64LE(32));
      const stride = bytes.readUInt16LE(54);
      const count = bytes.readUInt16LE(56);
      let changed = false;
      for (let index = 0; index < count; index++) {
        const program = table + index * stride;
        if (bytes.readUInt32LE(program) === 2) {
          if (field === "symbols") {
            const dynamic = Number(bytes.readBigUInt64LE(program + 8)),
              length = Number(bytes.readBigUInt64LE(program + 32));
            for (let p = dynamic; p < dynamic + length; p += 16)
              if (bytes.readBigInt64LE(p) === 6n) {
                bytes.writeBigUInt64LE(
                  bytes.readBigUInt64LE(p + 8) + 24n,
                  p + 8,
                );
                break;
              }
          } else {
            const slot = program + (field === "offset" ? 8 : 16);
            bytes.writeBigUInt64LE(bytes.readBigUInt64LE(slot) + 16n, slot);
          }
          changed = true;
          break;
        }
      }
      expect(changed).toBe(true);
      await writeFile(native, bytes);
      await expect(
        f.deploy(path.join(f.root, "runtime")),
      ).rejects.toMatchObject({ code: "ZYRK_DEPLOY_NONRELOCATABLE" });
    } finally {
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);

it.skipIf(!compiler)(
  "exports the validated native snapshot when its mutable source changes immediately after reading",
  async () => {
    const f = await fixture(
      'const char* snapshot_marker="original-native-snapshot";',
    );
    let restore: (() => void) | undefined;
    try {
      const native = await realpath(
        path.join(f.project, "node_modules/addon/addon.node"),
      );
      const before = await readFile(native),
        after = Buffer.from(before);
      const marker = after.indexOf(Buffer.from("original-native-snapshot"));
      expect(marker).toBeGreaterThan(-1);
      Buffer.from("modified-native-snapshot").copy(after, marker);
      const handle = await open(native, "r");
      type Reader = {
        read(
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ): Promise<{ bytesRead: number; buffer: Buffer }>;
      };
      const prototype = Object.getPrototypeOf(handle) as Reader;
      await handle.close();
      const originalRead = prototype.read;
      let changed = false;
      const spy = vi
        .spyOn(prototype, "read")
        .mockImplementation(async function (
          this: Reader,
          buffer,
          offset,
          length,
          position,
        ) {
          const result = await originalRead.call(
            this,
            buffer,
            offset,
            length,
            position,
          );
          if (
            !changed &&
            position === 0 &&
            result.bytesRead === before.length &&
            buffer.equals(before)
          ) {
            changed = true;
            await writeFile(native, after);
          }
          return result;
        });
      restore = () => spy.mockRestore();
      const out = path.join(f.root, "runtime");
      await f.deploy(out);
      expect(changed).toBe(true);
      expect(await readFile(native)).toEqual(after);
      expect(
        await readFile(path.join(out, "node_modules/addon/addon.node")),
      ).toEqual(before);
    } finally {
      restore?.();
      await f.server.close();
      await rmrfNoFollow(f.root);
    }
  },
);
