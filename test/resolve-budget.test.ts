import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PackumentVersion } from "../src/fetch/registry.ts";
import {
  resolveRequirements,
  type MetadataProvider,
} from "../src/resolve/resolver.ts";

function provider(
  entries: Record<string, Partial<PackumentVersion>>,
): MetadataProvider {
  return {
    origin: "https://registry.example",
    async packument(name) {
      const entry: PackumentVersion = {
        name,
        version: "1.0.0",
        dist: {
          tarball: `https://registry.example/${name}.tgz`,
          integrity: `sha512-${createHash("sha512").update(name).digest("base64")}`,
        },
        ...entries[name],
      };
      return {
        name,
        distTags: { latest: "1.0.0" },
        versions: { "1.0.0": entry },
      };
    },
  };
}
const requirements = [{ name: "app", spec: "1.0.0" }];

describe("resolver resource limits", () => {
  const chain = {
    app: { dependencies: { child: "*" } },
    child: { dependencies: { leaf: "*" } },
    leaf: {},
  };
  it("bounds selected nodes before publishing an unbounded graph", async () => {
    await expect(
      resolveRequirements({
        provider: provider(chain),
        requirements,
        limits: { maxNodes: 2 },
      }),
    ).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
      message: expect.stringContaining("node limit"),
    });
  });
  it("bounds dependency depth, including ever-new peer-bearing cycles", async () => {
    const cyclic = {
      app: { dependencies: { child: "*" }, peerDependencies: { host: "*" } },
      child: { dependencies: { app: "*" }, peerDependencies: { host: "*" } },
      host: {},
    };
    await expect(
      resolveRequirements({
        provider: provider(cyclic),
        requirements,
        limits: { maxDepth: 3 },
      }),
    ).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
      message: expect.stringContaining("depth limit"),
    });
  });
  it("times out a stalled metadata provider", async () => {
    const stalled: MetadataProvider = {
      origin: "https://registry.example",
      packument: () => new Promise(() => {}),
    };
    await expect(
      resolveRequirements({
        provider: stalled,
        requirements,
        limits: { deadlineMs: 10 },
      }),
    ).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
      message: expect.stringContaining("deadline"),
    });
  });
  it("bounds peer fixpoint rounds and canonical peer expansion", async () => {
    const peers = provider({
      app: { peerDependencies: { host: "*" } },
      host: {},
    });
    await expect(
      resolveRequirements({
        provider: peers,
        requirements,
        limits: { maxPeerRounds: 1 },
      }),
    ).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
      message: expect.stringContaining("iteration limit"),
    });
    await expect(
      resolveRequirements({
        provider: peers,
        requirements,
        limits: { maxPeerExpansions: 1 },
      }),
    ).rejects.toMatchObject({
      code: "ZYRK_RESOLUTION_FAILED",
      message: expect.stringContaining("expansion limit"),
    });
  });
  it("preserves ordinary alias cycles within configured limits", async () => {
    const graph = await resolveRequirements({
      provider: provider({ app: { dependencies: { alias: "npm:app@1.0.0" } } }),
      requirements,
      limits: { maxNodes: 1, maxDepth: 1 },
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.edges[0]?.target).toBe(graph.roots[0]?.target);
  });
});

describe("platform selection", () => {
  const platform = { os: "linux", cpu: "x64", libc: "glibc" };
  it("reports omitted optional subtrees and retains required dependencies", async () => {
    const graph = await resolveRequirements({
      provider: provider({
        app: {
          dependencies: { required: "*" },
          optionalDependencies: { optional: "*" },
        },
        required: {},
        optional: { dependencies: { wrong: "*" } },
        wrong: { os: ["win32"] },
      }),
      requirements,
      platform,
    });
    expect(graph.nodes.map((node) => node.name)).toEqual(["app", "required"]);
    expect(graph.omissions).toEqual([
      { name: "optional", parent: "app@1.0.0", reason: "platform" },
    ]);
  });
  it("does not omit required packages with incompatible OS, CPU or libc", async () => {
    for (const constraint of [
      { os: ["!linux"] },
      { cpu: ["arm64"] },
      { libc: ["musl"] },
    ]) {
      await expect(
        resolveRequirements({
          provider: provider({ app: constraint }),
          requirements,
          platform,
        }),
      ).rejects.toMatchObject({
        code: "ZYRK_RESOLUTION_FAILED",
        message: expect.stringContaining("current platform"),
      });
    }
  });
  it("supports negative-only constraints and matching libc", async () => {
    const graph = await resolveRequirements({
      provider: provider({
        app: { os: ["!win32"], cpu: ["x64"], libc: ["glibc"] },
      }),
      requirements,
      platform,
    });
    expect(graph.nodes).toHaveLength(1);
  });
  it("optional declarations override the same prod name and root optionality is explicit", async () => {
    const source = provider({
      app: {
        dependencies: { wrong: "^2" },
        optionalDependencies: { wrong: "1.0.0" },
      },
      wrong: { os: ["win32"] },
    });
    const graph = await resolveRequirements({
      provider: source,
      requirements,
      platform,
    });
    expect(graph.nodes).toHaveLength(1);
    const root = await resolveRequirements({
      provider: source,
      requirements: [{ name: "wrong", spec: "*", optional: true }],
      platform,
    });
    expect(root.nodes).toEqual([]);
    expect(root.omissions?.[0]?.name).toBe("wrong");
  });
});
