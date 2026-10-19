import { expect, it } from "vitest";
import { selectPlatformGraph } from "../src/install/platform.ts";
import type { ResolvedOccurrence } from "../src/resolve/resolver.ts";

function node(
  name: string,
  extra: Partial<ResolvedOccurrence> = {},
): ResolvedOccurrence {
  return {
    key: name,
    name,
    version: "1.0.0",
    sourceId: name,
    integrity: "unused",
    origin: "https://registry.example",
    tarballUrl: "https://registry.example/package.tgz",
    bin: {},
    platform: {},
    peerBindings: [],
    edges: [],
    ...extra,
  };
}
it("omits a whole optional closure when its required descendant is incompatible, including cycles", () => {
  const root = node("root", {
    edges: [
      { name: "optional", target: "optional", kind: "optional", spec: "1" },
    ],
  });
  const optional = node("optional", {
    edges: [{ name: "child", target: "child", kind: "prod", spec: "1" }],
  });
  const child = node("child", {
    platform: { cpu: ["arm64"] },
    edges: [{ name: "optional", target: "optional", kind: "prod", spec: "1" }],
  });
  const graph = {
    nodes: [root, optional, child],
    roots: [{ name: "root", target: "root" }],
  };
  expect(
    selectPlatformGraph(graph, new Set(), {
      os: "linux",
      cpu: "x64",
    }).nodes.map((n) => n.name),
  ).toEqual(["root"]);
  expect(
    selectPlatformGraph(graph, new Set(), { os: "linux", cpu: "arm64" }).nodes,
  ).toHaveLength(3);
  root.edges[0]!.kind = "prod";
  expect(() =>
    selectPlatformGraph(graph, new Set(), { os: "linux", cpu: "x64" }),
  ).toThrow(expect.objectContaining({ code: "ZYRK_PLATFORM_UNSUPPORTED" }));
});
it("removes incompatible optional peers and their binding from the local graph without mutating the lock graph", () => {
  const root = node("root", {
    edges: [{ name: "peer", target: "peer", kind: "peer", spec: "1" }],
    peerBindings: [{ name: "peer", target: "peer", optional: true }],
  });
  const peer = node("peer", { platform: { os: ["linux"], libc: ["musl"] } });
  const graph = {
    nodes: [root, peer],
    roots: [{ name: "root", target: "root" }],
  };
  const active = selectPlatformGraph(graph, new Set(), {
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  });
  expect(active.nodes).toHaveLength(1);
  expect(active.nodes[0]!.edges).toEqual([]);
  expect(active.nodes[0]!.peerBindings).toEqual([
    { name: "peer", target: null, optional: true },
  ]);
  expect(root.peerBindings[0]!.target).toBe("peer");
  expect(
    selectPlatformGraph(graph, new Set(), {
      os: "linux",
      cpu: "x64",
      libc: "musl",
    }).nodes,
  ).toHaveLength(2);
});
