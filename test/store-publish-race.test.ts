import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractTarball } from "../src/extract/tarball.ts";
import { contextIdFor, createGraphDoc } from "../src/store/graph.ts";
import { Store } from "../src/store/layout.ts";
import { realizeGraph, realizationDirFor } from "../src/store/realize.ts";
import { commitExtractedSource } from "../src/store/source.ts";
import { verifyRealization } from "../src/store/verify.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
import { craftTar } from "./helpers/tar.ts";

const fault = vi.hoisted(() => ({
  destination: "",
  winner: "none",
  error: undefined as NodeJS.ErrnoException | undefined,
  hits: 0,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] !== fault.destination || !fault.error)
        return fs.rename(...args);
      fault.hits++;
      if (fault.winner !== "absent") {
        // A different publisher completed the same atomic publication first.
        await fs.rename(...args);
        await fs.chmod(args[1], 0o555);
        if (fault.winner === "corrupt") {
          const packageDir = `${args[1]}/node_modules/example`;
          await fs.chmod(packageDir, 0o755);
          // Replace the hard link before tampering so the verified CAS object
          // remains intact; only the concurrent winner has bad payload bytes.
          await fs.unlink(`${packageDir}/index.js`);
          await fs.writeFile(`${packageDir}/index.js`, "untrusted winner", {
            mode: 0o444,
          });
          await fs.chmod(packageDir, 0o555);
        }
      }
      throw fault.error;
    },
  };
});
let root = "";
afterEach(async () => {
  fault.destination = "";
  fault.error = undefined;
  fault.hits = 0;
  if (root) await rmrfNoFollow(root);
});
async function fixture(winner: string, errno: string) {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-publish-race-"));
  const store = await Store.open({
    root: path.join(root, "store"),
    create: true,
  });
  const staging = path.join(root, "fetch");
  await mkdir(staging);
  const tarballPath = path.join(staging, "package.tar");
  await writeFile(
    tarballPath,
    craftTar([
      { path: "package", type: "dir" },
      {
        path: "package/package.json",
        data: JSON.stringify({ name: "example", version: "1.0.0" }),
      },
      { path: "package/index.js", data: "module.exports=42" },
    ]),
  );
  const extraction = await extractTarball({
    tarballPath,
    destDir: path.join(staging, "extract"),
  });
  const source = await commitExtractedSource({
    store,
    extraction,
    name: "example",
    version: "1.0.0",
    origin: "https://registry.npmjs.org",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    archiveBytes: 1024,
  });
  const graph = createGraphDoc([
    { name: "example", version: "1.0.0", sourceId: source.sourceId },
  ]);
  const key = graph.nodes[0]!.key;
  const contextId = contextIdFor(graph, key);
  fault.destination = realizationDirFor(store, contextId);
  fault.winner = winner;
  fault.error = Object.assign(
    new Error("injected realization rename failure"),
    { code: errno },
  );
  return { store, graph, key, contextId };
}
it.each(["EACCES", "EPERM"])(
  "verifies and reuses a complete concurrent winner after %s",
  async (errno) => {
    const f = await fixture("valid", errno);
    const result = await realizeGraph(f);
    expect(fault.hits).toBe(1);
    expect(result.created).toEqual([]);
    expect(result.reused).toEqual([f.contextId]);
    await verifyRealization({ ...f, rootKey: f.key });
  },
);
it.each([true, false])(
  "rejects a corrupt concurrent winner after EACCES even with verifyPayloads=%s",
  async (verifyPayloads) => {
    const f = await fixture("corrupt", "EACCES");
    await expect(realizeGraph({ ...f, verifyPayloads })).rejects.toMatchObject({
      code: "ZYRK_STORE_CORRUPT",
    });
    expect(fault.hits).toBe(1);
    expect(
      await readFile(
        path.join(fault.destination, "node_modules/example/index.js"),
        "utf8",
      ),
    ).toBe("untrusted winner");
  },
);
it("preserves the original permission error when no concurrent winner exists", async () => {
  const f = await fixture("absent", "EPERM");
  const expected = fault.error;
  await expect(realizeGraph(f)).rejects.toBe(expected);
  expect(fault.hits).toBe(1);
  expect(await pathExists(fault.destination)).toBe(false);
});
