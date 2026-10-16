import { describe, expect, it } from "vitest";
import {
  contextIdFor,
  createGraphDoc,
  graphHash,
  nodeKeyOf,
  validateGraph,
  type GraphDoc,
} from "../src/store/graph.ts";

const ALPHA = nodeKeyOf("alpha", "1.0.0");
const BETA = nodeKeyOf("beta", "1.0.0");
const BETA_NEXT = nodeKeyOf("beta", "1.0.1");
const GAMMA = nodeKeyOf("gamma", "2.0.0");

function baseGraph(): GraphDoc {
  return createGraphDoc([
    {
      name: "alpha",
      version: "1.0.0",
      sourceId: "src-alpha",
      deps: [{ name: "beta", target: BETA }],
    },
    { name: "beta", version: "1.0.0", sourceId: "src-beta" },
  ]);
}

describe("createGraphDoc", () => {
  it("canonically sorts nodes and edges regardless of input order", () => {
    const doc = createGraphDoc([
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
      {
        name: "z",
        version: "1.0.0",
        sourceId: "src-z",
        deps: [
          { name: "beta", target: BETA },
          { name: "alpha", target: ALPHA },
        ],
      },
      { name: "alpha", version: "1.0.0", sourceId: "src-alpha" },
    ]);
    expect(doc.nodes.map((node) => node.key)).toEqual([
      ALPHA,
      BETA,
      nodeKeyOf("z", "1.0.0"),
    ]);
    const z = doc.nodes[2];
    if (z === undefined) throw new Error("expected a node for z");
    expect(z.edges.map((edge) => edge.name)).toEqual(["alpha", "beta"]);
  });

  it("records the canonicalization version and derives keys from name and version", () => {
    const doc = baseGraph();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.canonicalizationVersion).toBe(1);
    expect(doc.nodes.map((node) => node.key)).toEqual([ALPHA, BETA]);
    expect(doc.nodes.map((node) => node.name)).toEqual(["alpha", "beta"]);
  });

  it("rejects duplicate node keys", () => {
    expect(() =>
      createGraphDoc([
        { name: "alpha", version: "1.0.0", sourceId: "src-a" },
        { name: "alpha", version: "1.0.0", sourceId: "src-b" },
      ]),
    ).toThrowError(/duplicate node key/);
  });

  it("rejects edges that target a node outside the graph", () => {
    expect(() =>
      createGraphDoc([
        {
          name: "alpha",
          version: "1.0.0",
          sourceId: "src-a",
          deps: [{ name: "beta", target: BETA }],
        },
      ]),
    ).toThrowError(/targets missing node/);
  });

  it("rejects two edges with the same dependency name on one node", () => {
    expect(() =>
      createGraphDoc([
        {
          name: "alpha",
          version: "1.0.0",
          sourceId: "src-a",
          deps: [
            { name: "beta", target: BETA },
            { name: "beta", target: BETA },
          ],
        },
        { name: "beta", version: "1.0.0", sourceId: "src-b" },
      ]),
    ).toThrowError(/duplicate dependency name/);
  });

  it("reports invalid graphs with the stable internal error code", () => {
    expect(() =>
      createGraphDoc([
        { name: "x", version: "1.0.0", sourceId: "s" },
        { name: "x", version: "1.0.0", sourceId: "s" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "SNPM_INTERNAL" }));
  });
});

describe("validateGraph", () => {
  it("rejects a node whose key does not match its name and version", () => {
    const doc = baseGraph();
    const first = doc.nodes[0];
    if (first === undefined) throw new Error("expected a node");
    const tampered: GraphDoc = {
      ...doc,
      nodes: [{ ...first, key: "gamma@9.9.9" }],
    };
    expect(() => validateGraph(tampered)).toThrowError(/does not match/);
  });

  it("rejects a document with a duplicated node appended", () => {
    const doc = baseGraph();
    const first = doc.nodes[0];
    if (first === undefined) throw new Error("expected a node");
    const tampered: GraphDoc = { ...doc, nodes: [...doc.nodes, { ...first }] };
    expect(() => validateGraph(tampered)).toThrowError(/duplicate node key/);
  });
});

describe("graphHash", () => {
  it("is identical under permuted input order", () => {
    const a = createGraphDoc([
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
    ]);
    const b = createGraphDoc([
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
    ]);
    expect(graphHash(a)).toBe(graphHash(b));
  });

  it("differs when an unrelated node is added while its closure context stays stable", () => {
    const before = baseGraph();
    const after = createGraphDoc([
      { name: "gamma", version: "2.0.0", sourceId: "src-gamma" },
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
    ]);
    expect(graphHash(after)).not.toBe(graphHash(before));
    expect(contextIdFor(after, ALPHA)).toBe(contextIdFor(before, ALPHA));
    expect(contextIdFor(after, GAMMA)).toBe(
      contextIdFor(
        createGraphDoc([
          { name: "gamma", version: "2.0.0", sourceId: "src-gamma" },
        ]),
        GAMMA,
      ),
    );
  });
});

describe("contextIdFor", () => {
  it("is deterministic under permuted input order", () => {
    const a = baseGraph();
    const b = createGraphDoc([
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
    ]);
    expect(contextIdFor(a, ALPHA)).toBe(contextIdFor(b, ALPHA));
    expect(contextIdFor(a, ALPHA).startsWith("ctx1_")).toBe(true);
  });

  it("is rooted: different roots in one graph get different ids", () => {
    const doc = baseGraph();
    expect(contextIdFor(doc, ALPHA)).not.toBe(contextIdFor(doc, BETA));
  });

  it("changes when a reachable dependency changes", () => {
    const before = baseGraph();
    const after = createGraphDoc([
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA_NEXT }],
      },
      { name: "beta", version: "1.0.1", sourceId: "src-beta" },
    ]);
    expect(contextIdFor(after, ALPHA)).not.toBe(contextIdFor(before, ALPHA));
  });

  it("does not change when an unrelated root is added", () => {
    const before = baseGraph();
    const after = createGraphDoc([
      { name: "gamma", version: "2.0.0", sourceId: "src-gamma" },
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
    ]);
    expect(contextIdFor(after, ALPHA)).toBe(contextIdFor(before, ALPHA));
    expect(contextIdFor(after, BETA)).toBe(contextIdFor(before, BETA));
  });

  it("distinguishes aliased edges that target the same node", () => {
    const direct = createGraphDoc([
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "beta", target: BETA }],
      },
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
    ]);
    const aliased = createGraphDoc([
      {
        name: "alpha",
        version: "1.0.0",
        sourceId: "src-alpha",
        deps: [{ name: "alias-beta", target: BETA }],
      },
      { name: "beta", version: "1.0.0", sourceId: "src-beta" },
    ]);
    expect(contextIdFor(aliased, ALPHA)).not.toBe(contextIdFor(direct, ALPHA));
  });

  it("keeps cycles finite and stable", () => {
    const cyclic = createGraphDoc([
      {
        name: "a",
        version: "1.0.0",
        sourceId: "src-a",
        deps: [{ name: "b", target: nodeKeyOf("b", "1.0.0") }],
      },
      {
        name: "b",
        version: "1.0.0",
        sourceId: "src-b",
        deps: [{ name: "a", target: nodeKeyOf("a", "1.0.0") }],
      },
    ]);
    const permuted = createGraphDoc([
      {
        name: "b",
        version: "1.0.0",
        sourceId: "src-b",
        deps: [{ name: "a", target: nodeKeyOf("a", "1.0.0") }],
      },
      {
        name: "a",
        version: "1.0.0",
        sourceId: "src-a",
        deps: [{ name: "b", target: nodeKeyOf("b", "1.0.0") }],
      },
    ]);
    const a = contextIdFor(cyclic, nodeKeyOf("a", "1.0.0"));
    expect(a).toBe(contextIdFor(permuted, nodeKeyOf("a", "1.0.0")));
    expect(a).not.toBe(contextIdFor(cyclic, nodeKeyOf("b", "1.0.0")));
  });

  it("requires the root to be part of the graph", () => {
    const doc = baseGraph();
    expect(() => contextIdFor(doc, "missing@1.0.0")).toThrowError(
      /not in the graph/,
    );
  });
});
