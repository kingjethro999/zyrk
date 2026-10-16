import { describe, expect, it } from "vitest";
import { ZyrkError } from "../src/errors.ts";
import type { Packument, PackumentVersion } from "../src/fetch/registry.ts";
import {
  resolveRequirements,
  type MetadataProvider,
  type ResolvedOccurrence,
} from "../src/resolve/resolver.ts";
import { parseRequirement } from "../src/resolve/spec.ts";
import { createGraphDoc, contextIdFor, graphHash } from "../src/store/graph.ts";
import { sourceIdOf } from "../src/util/hash.ts";

type FakeVersion = {
  version: string;
  deps?: Record<string, string>;
  optionalDeps?: Record<string, string>;
  peerDeps?: Record<string, string>;
  peerMeta?: Record<string, { optional?: boolean }>;
  bundled?: string[] | boolean;
};

function integrityFor(name: string, version: string): string {
  return `sha512-${Buffer.from(`${name}@${version}`).toString("base64")}`;
}

function versionEntry(name: string, fake: FakeVersion): PackumentVersion {
  return {
    name,
    version: fake.version,
    dist: {
      tarball: `https://registry.example.com/${name}/-/${name}-${fake.version}.tgz`,
      integrity: integrityFor(name, fake.version),
    },
    ...(fake.deps === undefined ? {} : { dependencies: fake.deps }),
    ...(fake.optionalDeps === undefined
      ? {}
      : { optionalDependencies: fake.optionalDeps }),
    ...(fake.peerDeps === undefined ? {} : { peerDependencies: fake.peerDeps }),
    ...(fake.peerMeta === undefined
      ? {}
      : { peerDependenciesMeta: fake.peerMeta }),
    ...(fake.bundled === undefined
      ? {}
      : { bundledDependencies: fake.bundled }),
  };
}

function packumentOf(
  name: string,
  versions: FakeVersion[],
  tags?: Record<string, string>,
): Packument {
  const entries: Record<string, PackumentVersion> = {};
  for (const fake of versions) entries[fake.version] = versionEntry(name, fake);
  const sorted = [...versions].map((fake) => fake.version).sort();
  return {
    name,
    distTags: tags ?? { latest: sorted[sorted.length - 1] ?? "0.0.0" },
    versions: entries,
  };
}

class FakeProvider implements MetadataProvider {
  readonly origin = "https://registry.example.com";
  private readonly docs: Map<string, Packument>;

  constructor(docs: Array<[string, Packument]>) {
    this.docs = new Map(docs);
  }

  async packument(name: string): Promise<Packument> {
    const doc = this.docs.get(name);
    if (doc === undefined) {
      throw new ZyrkError(
        "ZYRK_RESOLUTION_FAILED",
        `not found while trying to fetch metadata for ${name} (HTTP 404)`,
        {
          detail: { name },
          remedy: "verify the package name exists in the configured registry",
        },
      );
    }
    return doc;
  }
}

function byKey(nodes: ResolvedOccurrence[]): Map<string, ResolvedOccurrence> {
  return new Map(nodes.map((node) => [node.key, node]));
}

function toGraphDoc(nodes: ResolvedOccurrence[]) {
  return createGraphDoc(
    nodes.map((node) => ({
      key: node.key,
      name: node.name,
      version: node.version,
      sourceId: node.sourceId,
      deps: node.edges.map((edge) => ({
        name: edge.name,
        target: edge.target,
      })),
    })),
  );
}

describe("parseRequirement", () => {
  it("parses exact, range, tag, and bare specs", () => {
    expect(parseRequirement("alpha", "1.2.3")).toMatchObject({
      edgeName: "alpha",
      realName: "alpha",
      kind: "exact",
      targetSpec: "1.2.3",
      targetKind: "exact",
    });
    expect(parseRequirement("alpha", "^1.0.0")).toMatchObject({
      kind: "range",
      targetSpec: "^1.0.0",
      targetKind: "range",
    });
    expect(parseRequirement("alpha", "latest")).toMatchObject({
      kind: "tag",
      targetSpec: "latest",
      targetKind: "tag",
    });
    expect(parseRequirement("alpha", "")).toMatchObject({ realName: "alpha" });
  });

  it("parses npm aliases to their real package and target", () => {
    expect(parseRequirement("alt", "npm:real@^2.0.0")).toMatchObject({
      edgeName: "alt",
      realName: "real",
      kind: "alias",
      targetSpec: "^2.0.0",
      targetKind: "range",
    });
  });

  it("rejects deferred protocols explicitly", () => {
    for (const spec of ["git+https://example.com/repo.git", "./local-dir"]) {
      try {
        parseRequirement("alpha", spec);
        expect.unreachable(`expected "${spec}" to fail`);
      } catch (error) {
        expect(error).toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
        expect(error).toMatchObject({
          remedy: expect.stringContaining("deferred"),
        });
      }
    }
  });
});

describe("version selection", () => {
  const provider = new FakeProvider([
    [
      "alpha",
      packumentOf(
        "alpha",
        [{ version: "1.0.0" }, { version: "1.1.0" }, { version: "2.0.0" }],
        { latest: "2.0.0", next: "1.1.0" },
      ),
    ],
  ]);

  it.each([
    ["1.1.0", "1.1.0"],
    ["^1.0.0", "1.1.0"],
    ["*", "2.0.0"],
    ["", "2.0.0"],
    ["latest", "2.0.0"],
    ["next", "1.1.0"],
  ])("resolves %s to %s", async (spec, version) => {
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [{ name: "alpha", spec }],
    });
    expect(nodes.map((node) => node.key)).toEqual([`alpha@${version}`]);
  });

  it("fails for missing versions and tags", async () => {
    for (const spec of ["9.9.9", "^9.0.0", "no-such-tag"]) {
      await expect(
        resolveRequirements({
          provider,
          requirements: [{ name: "alpha", spec }],
        }),
      ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    }
  });

  it("fails for unknown packages", async () => {
    await expect(
      resolveRequirements({
        provider,
        requirements: [{ name: "ghost", spec: "1.0.0" }],
      }),
    ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
  });
});

describe("aliases and transitive closure", () => {
  const provider = new FakeProvider([
    ["real", packumentOf("real", [{ version: "2.0.0" }, { version: "2.1.0" }])],
    [
      "app",
      packumentOf("app", [
        { version: "1.0.0", deps: { alt: "npm:real@^2.0.0", beta: "^1.0.0" } },
      ]),
    ],
    ["beta", packumentOf("beta", [{ version: "1.0.0" }, { version: "1.5.0" }])],
  ]);

  it("keeps the alias on the edge and the real name on the node", async () => {
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [{ name: "app", spec: "1.0.0" }],
    });
    const app = byKey(nodes).get("app@1.0.0");
    if (app === undefined) throw new Error("expected app node");
    expect(app.edges).toContainEqual({
      name: "alt",
      target: "real@2.1.0",
      kind: "prod",
      spec: "npm:real@^2.0.0",
    });
    expect(app.edges).toContainEqual({
      name: "beta",
      target: "beta@1.5.0",
      kind: "prod",
      spec: "^1.0.0",
    });
    const real = byKey(nodes).get("real@2.1.0");
    if (real === undefined) throw new Error("expected real node");
    expect(real.name).toBe("real");
    expect(real.sourceId).toBe(
      sourceIdOf({
        sourceType: "registry",
        name: "real",
        version: "2.1.0",
        origin: provider.origin,
        integrity: integrityFor("real", "2.1.0"),
      }),
    );
  });

  it("terminates on dependency cycles", async () => {
    const cyclic = new FakeProvider([
      ["a", packumentOf("a", [{ version: "1.0.0", deps: { b: "^1.0.0" } }])],
      ["b", packumentOf("b", [{ version: "1.0.0", deps: { a: "^1.0.0" } }])],
    ]);
    const { nodes } = await resolveRequirements({
      provider: cyclic,
      requirements: [{ name: "a", spec: "1.0.0" }],
    });
    expect(nodes.map((node) => node.key).sort()).toEqual([
      "a@1.0.0",
      "b@1.0.0",
    ]);
  });

  it("skips bundled subtrees without exposing them", async () => {
    const bundled = new FakeProvider([
      [
        "bundle",
        packumentOf("bundle", [
          { version: "1.0.0", deps: { inner: "1.0.0" }, bundled: ["inner"] },
        ]),
      ],
      ["inner", packumentOf("inner", [{ version: "1.0.0" }])],
    ]);
    const { nodes } = await resolveRequirements({
      provider: bundled,
      requirements: [{ name: "bundle", spec: "1.0.0" }],
    });
    expect(nodes.map((node) => node.key)).toEqual(["bundle@1.0.0"]);
  });
});

describe("peer dependencies", () => {
  function hostsProvider(): FakeProvider {
    return new FakeProvider([
      [
        "host",
        packumentOf("host", [{ version: "1.0.0" }, { version: "2.0.0" }]),
      ],
      [
        "plugin",
        packumentOf("plugin", [{ version: "1.0.0", peerDeps: { host: "*" } }]),
      ],
      [
        "app1",
        packumentOf("app1", [
          { version: "1.0.0", deps: { plugin: "1.0.0", host: "1.0.0" } },
        ]),
      ],
      [
        "app2",
        packumentOf("app2", [
          { version: "1.0.0", deps: { plugin: "1.0.0", host: "2.0.0" } },
        ]),
      ],
    ]);
  }

  it("shares one occurrence when peer bindings match", async () => {
    const provider = hostsProvider();
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [
        { name: "app1", spec: "1.0.0" },
        { name: "host", spec: "1.0.0" },
      ],
    });
    const map = byKey(nodes);
    expect(map.get("host@1.0.0")).toBeDefined();
    const plugin = nodes.find((node) => node.name === "plugin");
    if (plugin === undefined)
      throw new Error("expected a shared plugin occurrence");
    expect(nodes.filter((node) => node.name === "plugin")).toHaveLength(1);
    expect(plugin.peerBindings).toEqual([
      { name: "host", target: "host@1.0.0" },
    ]);
    expect(plugin.edges).toContainEqual({
      name: "host",
      target: "host@1.0.0",
      kind: "peer",
      spec: "*",
    });
  });

  it("splits one source into two contexts when peer bindings differ", async () => {
    const provider = hostsProvider();
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [
        { name: "app1", spec: "1.0.0" },
        { name: "app2", spec: "1.0.0" },
      ],
    });
    const plugins = nodes.filter((node) => node.name === "plugin");
    expect(plugins).toHaveLength(2);
    expect(plugins[0]?.key).not.toBe(plugins[1]?.key);
    expect(plugins[0]?.sourceId).toBe(plugins[1]?.sourceId);
    const targets = plugins
      .map(
        (plugin) =>
          plugin.peerBindings.find((binding) => binding.name === "host")
            ?.target,
      )
      .sort();
    expect(targets).toEqual(["host@1.0.0", "host@2.0.0"]);

    // Both contexts validate as one graph document with distinct contexts.
    const doc = toGraphDoc(nodes);
    const app1 = byKey(nodes).get("app1@1.0.0");
    const app2 = byKey(nodes).get("app2@1.0.0");
    if (app1 === undefined || app2 === undefined)
      throw new Error("expected app nodes");
    const pluginFor = (app: (typeof nodes)[number]): string => {
      const edge = app.edges.find((item) => item.name === "plugin");
      if (edge === undefined) throw new Error("expected a plugin edge");
      return edge.target;
    };
    expect(pluginFor(app1)).not.toBe(pluginFor(app2));
    expect(contextIdFor(doc, "app1@1.0.0")).not.toBe(
      contextIdFor(doc, "app2@1.0.0"),
    );
  });

  it("fails incompatible required peers naming the chain", async () => {
    const provider = new FakeProvider([
      ["host", packumentOf("host", [{ version: "1.0.0" }])],
      [
        "plugin",
        packumentOf("plugin", [
          { version: "1.0.0", peerDeps: { host: "^2.0.0" } },
        ]),
      ],
    ]);
    const failure = await resolveRequirements({
      provider,
      requirements: [
        { name: "host", spec: "1.0.0" },
        { name: "plugin", spec: "1.0.0" },
      ],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ZYRK_PEER_CONFLICT" });
    expect(failure).toMatchObject({
      detail: expect.objectContaining({
        peer: "host",
        chain: expect.any(Array),
      }),
    });
  });

  it("records absent optional peers without an edge", async () => {
    const provider = new FakeProvider([
      [
        "picky",
        packumentOf("picky", [
          {
            version: "1.0.0",
            peerDeps: { ghost: "^1.0.0" },
            peerMeta: { ghost: { optional: true } },
          },
        ]),
      ],
    ]);
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [{ name: "picky", spec: "1.0.0" }],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.peerBindings).toEqual([{ name: "ghost", target: null }]);
    expect(nodes[0]?.edges).toEqual([]);
  });

  it("auto-selects a missing required peer", async () => {
    const provider = new FakeProvider([
      [
        "fresh",
        packumentOf("fresh", [{ version: "1.2.0" }, { version: "2.0.0" }]),
      ],
      [
        "needy",
        packumentOf("needy", [
          { version: "1.0.0", peerDeps: { fresh: "^1.0.0" } },
        ]),
      ],
    ]);
    const { nodes } = await resolveRequirements({
      provider,
      requirements: [{ name: "needy", spec: "1.0.0" }],
    });
    expect(nodes.map((node) => `${node.name}@${node.version}`).sort()).toEqual([
      "fresh@1.2.0",
      "needy@1.0.0",
    ]);
    expect(nodes.find((node) => node.name === "fresh")?.key).toBe(
      "fresh@1.2.0",
    );
    expect(nodes.find((node) => node.name === "needy")?.peerBindings).toEqual([
      { name: "fresh", target: "fresh@1.2.0" },
    ]);
  });

  it("terminates on peer cycles", async () => {
    const provider = new FakeProvider([
      [
        "pa",
        packumentOf("pa", [{ version: "1.0.0", peerDeps: { pb: "^1.0.0" } }]),
      ],
      [
        "pb",
        packumentOf("pb", [{ version: "1.0.0", peerDeps: { pa: "^1.0.0" } }]),
      ],
    ]);
    const first = await resolveRequirements({
      provider,
      requirements: [{ name: "pa", spec: "1.0.0" }],
    });
    const second = await resolveRequirements({
      provider,
      requirements: [{ name: "pb", spec: "1.0.0" }],
    });
    expect(first.nodes).toHaveLength(2);
    expect(second.nodes).toHaveLength(2);
    const doc = toGraphDoc(first.nodes);
    const pa = first.nodes.find((node) => node.name === "pa")?.key;
    const pb = first.nodes.find((node) => node.name === "pb")?.key;
    if (pa === undefined || pb === undefined)
      throw new Error("expected pa and pb nodes");
    expect(pa).not.toBe(pb);
    expect(contextIdFor(doc, pa)).not.toBe(contextIdFor(doc, pb));
  });
});

describe("determinism", () => {
  function shuffledProvider(): FakeProvider {
    const versions: FakeVersion[] = [
      { version: "2.0.0" },
      { version: "1.0.0" },
      { version: "1.1.0" },
    ];
    return new FakeProvider([
      [
        "zeta",
        packumentOf("zeta", [...versions].reverse(), { latest: "2.0.0" }),
      ],
      ["alpha", packumentOf("alpha", versions, { latest: "2.0.0" })],
      [
        "mid",
        packumentOf("mid", [
          { version: "1.0.0", deps: { zeta: "^2.0.0", alpha: "^1.0.0" } },
        ]),
      ],
    ]);
  }

  it("resolves identical graphs regardless of requirement and registry order", async () => {
    const provider = shuffledProvider();
    const first = await resolveRequirements({
      provider,
      requirements: [
        { name: "mid", spec: "1.0.0" },
        { name: "alpha", spec: "^1.0.0" },
      ],
    });
    const second = await resolveRequirements({
      provider,
      requirements: [
        { name: "alpha", spec: "^1.0.0" },
        { name: "mid", spec: "1.0.0" },
      ],
    });
    expect(first.nodes).toEqual(second.nodes);
    expect(graphHash(toGraphDoc(first.nodes))).toBe(
      graphHash(toGraphDoc(second.nodes)),
    );
  });

  it("keeps an unrelated addition from changing an existing context", async () => {
    const withExtra = new FakeProvider([
      ["zeta", packumentOf("zeta", [{ version: "2.0.0" }])],
      ["alpha", packumentOf("alpha", [{ version: "1.1.0" }])],
      [
        "mid",
        packumentOf("mid", [
          { version: "1.0.0", deps: { zeta: "^2.0.0", alpha: "^1.0.0" } },
        ]),
      ],
      ["extra", packumentOf("extra", [{ version: "3.0.0" }])],
    ]);
    const before = await resolveRequirements({
      provider: withExtra,
      requirements: [{ name: "mid", spec: "1.0.0" }],
    });
    const expanded = await resolveRequirements({
      provider: withExtra,
      requirements: [
        { name: "mid", spec: "1.0.0" },
        { name: "extra", spec: "3.0.0" },
      ],
    });
    expect(contextIdFor(toGraphDoc(expanded.nodes), "mid@1.0.0")).toBe(
      contextIdFor(toGraphDoc(before.nodes), "mid@1.0.0"),
    );
  });
});

describe("integrity and protocol failures", () => {
  it("rejects versions without integrity", async () => {
    const doc: Packument = {
      name: "loose",
      distTags: { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "loose",
          version: "1.0.0",
          dist: {
            tarball: "https://registry.example.com/loose/-/loose-1.0.0.tgz",
          },
        },
      },
    };
    const provider = new FakeProvider([["loose", doc]]);
    await expect(
      resolveRequirements({
        provider,
        requirements: [{ name: "loose", spec: "1.0.0" }],
      }),
    ).rejects.toMatchObject({ code: "ZYRK_INTEGRITY_FAILED" });
  });

  it("rejects Git and local specs without running anything", async () => {
    const provider = new FakeProvider([]);
    for (const spec of ["git+https://example.com/r.git", "file:./pkg.tgz"]) {
      await expect(
        resolveRequirements({
          provider,
          requirements: [{ name: "alpha", spec }],
        }),
      ).rejects.toMatchObject({ code: "ZYRK_RESOLUTION_FAILED" });
    }
  });
});
