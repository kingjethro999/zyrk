import { SnpmError } from "../errors.ts";
import { sha512Hex } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import { CONTEXT_CANONICALIZATION_VERSION } from "../version.ts";

/**
 * Resolved dependency graphs and deterministic context identity (SPEC 9.4).
 *
 * A graph node is one resolved occurrence: exact name, version, and verified
 * source identity. A context id binds the complete reachable subgraph of a
 * node — dependency edges and their transitive closures — but never
 * timestamps, download order, project paths, or input ordering. Nodes are
 * numbered by a canonical rooted traversal over sorted edge labels, so
 * permuted inputs serialize identically. Cycles stay finite references.
 */

export type GraphEdge = {
  /** The dependency name as it appears in `node_modules` (alias-aware). */
  name: string;
  /** Node key of the resolved target occurrence. */
  target: string;
};

export type GraphNode = {
  /**
   * `${name}@${version}`, or `${name}@${version}#${fingerprint}` when the
   * occurrence carries peer bindings: one verified source may back several
   * dependency contexts (SPEC 9.3), and each needs a distinct node.
   */
  key: string;
  name: string;
  version: string;
  sourceId: string;
  /** Canonically sorted by (name, target). */
  edges: GraphEdge[];
};

export type GraphDoc = {
  schemaVersion: 1;
  canonicalizationVersion: number;
  /** Canonically sorted by key. */
  nodes: GraphNode[];
};

export type GraphNodeInput = {
  /** Defaults to `nodeKeyOf(name, version)`; peer-split occurrences pass theirs. */
  key?: string;
  name: string;
  version: string;
  sourceId: string;
  deps?: Array<{ name: string; target: string }>;
};

export function nodeKeyOf(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Build a canonical graph document from arbitrarily ordered inputs. */
export function createGraphDoc(inputs: GraphNodeInput[]): GraphDoc {
  const nodes: GraphNode[] = inputs
    .map((input) => ({
      key: input.key ?? nodeKeyOf(input.name, input.version),
      name: input.name,
      version: input.version,
      sourceId: input.sourceId,
      edges: [...(input.deps ?? [])].sort(compareEdges),
    }))
    .sort((a, b) => compareStrings(a.key, b.key));
  const doc: GraphDoc = {
    schemaVersion: 1,
    canonicalizationVersion: CONTEXT_CANONICALIZATION_VERSION,
    nodes,
  };
  validateGraph(doc);
  return doc;
}

const PEER_KEY_SUFFIX = /^#[0-9a-f]{8,}$/;

export function validateGraph(doc: GraphDoc): void {
  const keys = new Set<string>();
  for (const node of doc.nodes) {
    const base = nodeKeyOf(node.name, node.version);
    const suffixed =
      node.key.startsWith(`${base}#`) &&
      PEER_KEY_SUFFIX.test(node.key.slice(base.length));
    if (node.key !== base && !suffixed) {
      fail(`node key ${node.key} does not match ${node.name}@${node.version}`);
    }
    if (keys.has(node.key)) fail(`duplicate node key ${node.key}`);
    keys.add(node.key);
  }
  for (const node of doc.nodes) {
    const names = new Set<string>();
    for (const edge of node.edges) {
      if (names.has(edge.name))
        fail(`duplicate dependency name ${edge.name} on ${node.key}`);
      names.add(edge.name);
      if (!keys.has(edge.target))
        fail(
          `edge ${edge.name} of ${node.key} targets missing node ${edge.target}`,
        );
    }
  }
}

/** Hash over the whole graph, independent of node ordering. */
export function graphHash(doc: GraphDoc): string {
  const serialized = doc.nodes.map((node) => [
    node.key,
    node.name,
    node.version,
    node.sourceId,
    node.edges.map((edge) => [edge.name, edge.target]),
  ]);
  return sha512Hex(
    canonicalJson({ v: doc.canonicalizationVersion, nodes: serialized }),
  );
}

/**
 * Deterministic context id for the subgraph reachable from `rootKey`
 * (SPEC 9.4). Canonical rooted traversal over sorted edge labels assigns
 * stable local node numbers; each node descriptor and its reference edges are
 * serialized once; the hash covers the canonical form.
 */
export function contextIdFor(doc: GraphDoc, rootKey: string): string {
  const byKey = new Map(doc.nodes.map((node) => [node.key, node]));
  if (!byKey.has(rootKey)) fail(`context root ${rootKey} is not in the graph`);

  const numbers = new Map<string, number>();
  const order: string[] = [];
  const visit = (key: string): void => {
    if (numbers.has(key)) return;
    numbers.set(key, order.length);
    order.push(key);
    const node = byKey.get(key);
    if (node === undefined) fail(`edge reaches missing node ${key}`);
    for (const edge of [...node.edges].sort(compareEdges)) visit(edge.target);
  };
  visit(rootKey);

  const serialized = order.map((key) => {
    const node = byKey.get(key);
    const number = numbers.get(key);
    if (node === undefined || number === undefined)
      fail(`internal numbering failure at ${key}`);
    return [
      number,
      node.name,
      node.version,
      node.sourceId,
      [...node.edges].sort(compareEdges).map((edge) => {
        const target = numbers.get(edge.target);
        if (target === undefined)
          fail(`edge ${edge.name} of ${key} was not numbered`);
        return [edge.name, target];
      }),
    ];
  });

  return `ctx1_${sha512Hex(canonicalJson({ v: doc.canonicalizationVersion, nodes: serialized }))}`;
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return compareStrings(a.name, b.name) || compareStrings(a.target, b.target);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fail(message: string): never {
  throw new SnpmError("SNPM_INTERNAL", message);
}
