import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { expect, it } from "vitest";
import {
  resolveRequirements,
  type MetadataProvider,
} from "../src/resolve/resolver.ts";
import type { PackumentVersion } from "../src/fetch/registry.ts";
import { discoverWorkspaces } from "../src/install/workspaces.ts";
import { resolveWorkspaceGraph } from "../src/install/workspace-graph.ts";

function provider(engines: unknown): MetadataProvider {
  return {
    origin: "https://registry.example",
    async packument(name) {
      return {
        name,
        distTags: { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            engines,
            dist: {
              tarball: `https://registry.example/${name}.tgz`,
              integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
            },
          } as PackumentVersion,
        },
      };
    },
  };
}
async function workspace(engines: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zyrk-legacy-engines-"));
  try {
    await mkdir(path.join(root, "packages/app"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
        dependencies: { legacy: "1.0.0" },
      }),
    );
    await writeFile(
      path.join(root, "packages/app/package.json"),
      JSON.stringify({ name: "app", version: "1.0.0" }),
    );
    return await resolveWorkspaceGraph(
      await discoverWorkspaces(root),
      provider(engines),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it.each(
  [["node >= 0.2.0"], ["node >= 0.2.0", "npm >=1"]].map((engines) => ({
    engines,
  })),
)(
  "normalizes legacy engine arrays in fresh standalone and workspace resolution: %j",
  async ({ engines }) => {
    const direct = await resolveRequirements({
      provider: provider(engines),
      requirements: [{ name: "legacy", spec: "1.0.0" }],
    });
    const expected = Object.fromEntries(
      engines.map((value) => {
        const space = value.indexOf(" ");
        return [value.slice(0, space), value.slice(space + 1)];
      }),
    );
    expect(direct.nodes[0]?.engines).toEqual(expected);
    const graph = await workspace(engines);
    expect(
      graph.nodes.find((node) => node.kind === "registry")?.engines,
    ).toEqual(expected);
  },
);
it.each(
  [
    ["node nonsense"],
    ["node"],
    [12],
    ["node >=1", "node >=2"],
    { node: 12 },
    null,
  ].map((engines) => ({ engines })),
)(
  "rejects malformed engines during fresh resolution: %j",
  async ({ engines }) => {
    await expect(
      resolveRequirements({
        provider: provider(engines),
        requirements: [{ name: "legacy", spec: "1.0.0" }],
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    await expect(workspace(engines)).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
    });
  },
);
