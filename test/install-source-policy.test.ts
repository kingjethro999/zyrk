import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { Store } from "../src/store/layout.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
it("rejects bundled payloads that would shadow the selected graph and retains the old projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zyrk-bundled-policy-"));
  const project = path.join(root, "project");
  await mkdir(project);
  const server = await startStubRegistry([
    {
      name: "plain",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: 'module.exports="plain";' } },
        },
      ],
    },
    {
      name: "bundled",
      versions: [
        {
          version: "1.0.0",
          files: {
            "index.js": { data: 'module.exports=require("hidden");' },
            "node_modules/hidden/index.js": {
              data: 'module.exports="hidden";',
            },
            "node_modules/hidden/package.json": {
              data: JSON.stringify({
                name: "hidden",
                version: "1.0.0",
                scripts: { postinstall: "exit 99" },
              }),
            },
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
      userAgent: "test",
    });
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ dependencies: { plain: "1.0.0" } }),
    );
    await installProject({ projectDir: project, store, registry });
    const old = await realpath(path.join(project, "node_modules/plain"));
    const lock = await readFile(
      path.join(project, "package-lock.json"),
      "utf8",
    );
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ dependencies: { bundled: "1.0.0" } }),
    );
    await expect(
      installProject({ projectDir: project, store, registry }),
    ).rejects.toMatchObject({
      code: "ZYRK_NOT_IMPLEMENTED",
      message: expect.stringContaining("bundled dependency payloads"),
    });
    expect(await realpath(path.join(project, "node_modules/plain"))).toBe(old);
    expect(
      await readFile(path.join(project, "package-lock.json"), "utf8"),
    ).toBe(lock);
  } finally {
    await server.close();
    await rmrfNoFollow(root);
  }
});
