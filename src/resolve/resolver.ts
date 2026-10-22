import { normalizeEngineConstraints } from "../util/engines.ts";
/**
 * Registry-backed dependency resolver (SPEC 9).
 *
 * Turns requirement strings into an immutable resolved graph: exact name,
 * version, origin-qualified source identity, dependency edges, and peer
 * bindings. No package code runs here; no project files are touched.
 *
 * Scope of this slice: registry versions, ranges, tags, scoped names, and
 * npm aliases; prod and optional groups; required and optional peers with
 * explicit-consumer-context bindings; cycles; bundled subtrees (skipped,
 * never exposed). Dev groups need full packuments and arrive later, as do
 * overrides and workspace relationships. Platform omissions are reported
 * explicitly, and resource limits bound graph construction. Remote
 * tarballs, Git, and local sources fail explicitly (SPEC 9.2).
 *
 * Peer contexts (SPEC 9.3-9.4): one verified source may back several
 * dependency contexts. Occurrences that declare peers are instantiated per
 * requesting parent and keyed by a fingerprint of their resolved peer
 * closure, so identical bindings share one occurrence while differing
 * bindings stay distinct. Peerless occurrences share by name@version.
 */

import { maxSatisfying, satisfies, valid } from "semver";
import { ZyrkError } from "../errors.ts";
import {
  expectedIntegrityFromDist,
  type Packument,
  type PackumentVersion,
} from "../fetch/registry.ts";
import { sha512Hex, sourceIdOf } from "../util/hash.ts";
import { canonicalJson } from "../util/json.ts";
import {
  createRootOverrides,
  type OverridePolicy,
  type OverrideContext,
} from "./overrides.ts";
import { parseRequirement } from "./spec.ts";

export type MetadataProvider = {
  readonly origin: string;
  originFor?(name: string): string;
  packument(name: string): Promise<Packument>;
  versionManifest?(name: string, version: string): Promise<PackumentVersion>;
};

export type EdgeKind = "prod" | "optional" | "peer";

export type ResolvedEdge = {
  /** Dependency name as it appears in `node_modules` (alias-aware). */
  name: string;
  /** Final occurrence key of the resolved target. */
  target: string;
  kind: EdgeKind;
  /** Requested spec, kept for diagnostics. */
  spec: string;
};

export type ResolvedOccurrence = {
  key: string;
  /** Registry package name; aliases live on edges, never here. */
  name: string;
  version: string;
  sourceId: string;
  integrity: string;
  /** Credential-free registry origin (SPEC 8.1). */
  origin: string;
  tarballUrl: string;
  bin: Record<string, string>;
  edges: ResolvedEdge[];
  peerBindings: Array<{
    name: string;
    target: string | null;
    optional?: boolean;
  }>;
  platform: { os?: string[]; cpu?: string[]; libc?: string[] };
  engines?: Record<string, string>;
};

export type ResolveOptions = {
  provider: MetadataProvider;
  requirements: Array<{ name: string; spec: string; optional?: boolean }>;
  overrides?: OverridePolicy;
  limits?: Partial<ResolverLimits>;
  platform?: RuntimePlatform;
  preservePlatformVariants?: boolean;
};

export type RuntimePlatform = { os: string; cpu: string; libc?: string };
export type ResolverLimits = {
  maxNodes: number;
  maxDepth: number;
  deadlineMs: number;
  maxPeerRounds: number;
  maxPeerExpansions: number;
};
export type ResolutionOmission = {
  name: string;
  reason: "platform";
  parent: string;
};

export function currentPlatform(): RuntimePlatform {
  const result: RuntimePlatform = { os: process.platform, cpu: process.arch };
  if (process.platform === "linux") {
    const report = process.report.getReport() as {
      header?: { glibcVersionRuntime?: string };
      sharedObjects?: string[];
    };
    if (report.header?.glibcVersionRuntime) result.libc = "glibc";
    else if (
      report.sharedObjects?.some((file) => /(?:ld-musl|libc.musl)/.test(file))
    )
      result.libc = "musl";
  }
  return result;
}

export type FinalizedGraph = {
  omissions?: ResolutionOmission[];
  nodes: ResolvedOccurrence[];
  /** Root requirement edge name -> occurrence key. */
  roots: Array<{ name: string; target: string }>;
};

export async function resolveRequirements(
  options: ResolveOptions,
): Promise<FinalizedGraph> {
  const state = new ResolverState(options);
  const rootFrame: Frame = {
    label: "<root>",
    children: [],
    overrideContext: state.overrides.root,
  };
  const seenRoots = new Set<string>();
  for (const requirement of [...options.requirements].sort((a, b) =>
    compareStrings(a.name, b.name),
  )) {
    if (seenRoots.has(requirement.name)) continue;
    seenRoots.add(requirement.name);
    const child = await state.buildChild(
      rootFrame,
      [],
      requirement.name,
      requirement.spec,
      requirement.optional ? "optional" : "prod",
    );
    if (child === null) continue;
    rootFrame.children.push({
      edgeName: requirement.name,
      kind: requirement.optional ? "optional" : "prod",
      spec: requirement.spec,
      child,
    });
  }
  await state.bindPeersToFixpoint();
  return state.finalize(
    rootFrame.children.map((link) => ({
      name: link.edgeName,
      child: link.child,
    })),
  );
}

// ---------------------------------------------------------------------------
// Internal occurrence graph. Edges reference occurrences, never key strings,
// until finalization assigns deterministic keys.
// ---------------------------------------------------------------------------

type ChildLink = {
  edgeName: string;
  kind: "prod" | "optional" | "peer";
  spec: string;
  child: Occurrence;
};

type Frame = {
  overrideContext: OverrideContext;
  label: string;
  children: ChildLink[];
};

type PeerSpec = {
  name: string;
  range: string;
  optional: boolean;
};

type Occurrence = {
  overrideContext: OverrideContext;
  name: string;
  version: string;
  entry: PackumentVersion;
  integrity: string;
  children: ChildLink[];
  peerSpecs: PeerSpec[];
  /** peer name -> bound occurrence, null for absent optional peers. */
  peerBindings: Map<string, Occurrence | null>;
  /** Creation stack, root-first; only populated when peers are declared. */
  chain: Frame[];
};

class ResolverState {
  readonly provider: MetadataProvider;
  readonly overrides: OverridePolicy;
  private readonly packuments = new Map<string, Promise<Packument>>();
  private readonly versionManifests = new Map<
    string,
    Promise<PackumentVersion>
  >();
  private readonly peerless = new Map<string, Occurrence>();
  private readonly peerBearing = new Map<Frame, Map<string, Occurrence>>();
  private readonly freshPeers = new Map<Occurrence, Map<string, Occurrence>>();
  private readonly occurrences: Occurrence[] = [];

  readonly limits: ResolverLimits;
  readonly platform: RuntimePlatform;
  readonly preservePlatformVariants: boolean;
  readonly omissions: ResolutionOmission[] = [];
  readonly expires: number;
  private peerExpansions = 0;
  constructor(options: ResolveOptions) {
    this.provider = options.provider;
    this.overrides = options.overrides ?? createRootOverrides({});
    this.limits = {
      maxNodes: 10000,
      maxDepth: 128,
      deadlineMs: 30000,
      maxPeerRounds: 1024,
      maxPeerExpansions: 100000,
      ...options.limits,
    };
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw budgetError("invalid resolver limits");
    this.platform = options.platform ?? currentPlatform();
    this.preservePlatformVariants = options.preservePlatformVariants === true;
    this.expires = Date.now() + this.limits.deadlineMs;
  }
  checkBudget(depth = 0, adding = false): void {
    if (Date.now() >= this.expires)
      throw budgetError("resolution deadline exceeded");
    if (depth > this.limits.maxDepth)
      throw budgetError("dependency depth limit exceeded");
    if (adding && this.occurrences.length >= this.limits.maxNodes)
      throw budgetError("resolved node limit exceeded");
  }
  private checkPlatform(name: string, entry: PackumentVersion): void {
    if (this.preservePlatformVariants) return;
    for (const [constraints, actual] of [
      [entry.os, this.platform.os],
      [entry.cpu, this.platform.cpu],
      [entry.libc, this.platform.libc],
    ] as const) {
      if (!constraints?.length) continue;
      const positive = constraints.filter((value) => !value.startsWith("!"));
      if (
        !actual ||
        constraints.includes(`!${actual}`) ||
        (positive.length > 0 &&
          !positive.includes(actual) &&
          !positive.includes("any"))
      )
        throw new PlatformMismatch(name);
    }
  }

  /** Cached packument fetch shared by version selection. */
  packumentOf(name: string): Promise<Packument> {
    const cached = this.packuments.get(name);
    if (cached !== undefined) return cached;
    this.checkBudget();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(budgetError("resolution deadline exceeded")),
        Math.max(1, this.expires - Date.now()),
      );
    });
    const pending = Promise.race([
      this.provider.packument(name),
      deadline,
    ]).finally(() => clearTimeout(timer));
    this.packuments.set(name, pending);
    return pending;
  }

  versionManifestOf(name: string, version: string): Promise<PackumentVersion> {
    const key = `${name}\0${version}`;
    const cached = this.versionManifests.get(key);
    if (cached !== undefined) return cached;
    this.checkBudget();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(budgetError("resolution deadline exceeded")),
        Math.max(1, this.expires - Date.now()),
      );
    });
    const pending = Promise.race([
      this.provider.versionManifest!(name, version),
      deadline,
    ]).finally(() => clearTimeout(timer));
    this.versionManifests.set(key, pending);
    return pending;
  }

  /**
   * Build (or reuse) the occurrence for one dependency edge. Peerless
   * packages share one occurrence per name@version; packages declaring
   * peers are instantiated per requesting parent frame so each gets the
   * bindings of its own consumer context.
   */
  async buildChild(
    parentFrame: Frame,
    chain: Frame[],
    edgeName: string,
    rawSpec: string,
    kind: "prod" | "optional",
  ): Promise<Occurrence | null> {
    try {
      return await this.buildRequiredChild(
        parentFrame,
        chain,
        edgeName,
        rawSpec,
        kind,
      );
    } catch (error) {
      if (kind !== "optional" || !(error instanceof PlatformMismatch))
        throw error;
      this.omissions.push({
        name: edgeName,
        reason: "platform",
        parent: parentFrame.label,
      });
      return null;
    }
  }

  async buildRequiredChild(
    parentFrame: Frame,
    chain: Frame[],
    edgeName: string,
    rawSpec: string,
    kind: "prod" | "optional",
  ): Promise<Occurrence> {
    this.checkBudget();
    const override = this.overrides.select(
      parentFrame.overrideContext,
      edgeName,
      rawSpec,
    );
    // Root override legality was checked against the declared manifest.
    // A caller may pass an existing exact root pin inside that declaration;
    // applying the identical declared range again would discard the pin.
    const req = parseRequirement(
      edgeName,
      parentFrame.label === "<root>" ? rawSpec : override.spec,
    );
    const { version, entry } = await selectVersion(this, req);
    this.checkPlatform(req.realName, entry);
    const integrity = expectedIntegrityFromDist(entry.dist);
    if (integrity === undefined) {
      throw new ZyrkError(
        "ZYRK_INTEGRITY_FAILED",
        `registry metadata for ${req.realName}@${version} carries no integrity digest`,
        {
          detail: { name: req.realName, version },
          remedy:
            "strict policy rejects unpinned archives; configure the origin-verification policy explicitly to accept and pin one",
        },
      );
    }
    const baseKey = `${req.realName}@${version}`;
    const memoKey = `${baseKey}\0${override.context.id}`;
    const hasPeers = peerSpecsOf(entry).length > 0;

    if (!hasPeers) {
      const existing = this.peerless.get(memoKey);
      if (existing !== undefined) return existing;
    } else {
      let perParent = this.peerBearing.get(parentFrame);
      if (perParent === undefined) {
        perParent = new Map();
        this.peerBearing.set(parentFrame, perParent);
      } else {
        const existing = perParent.get(memoKey);
        if (existing !== undefined) return existing;
      }
    }

    this.checkBudget(chain.length, true);
    const occ: Occurrence = {
      overrideContext: override.context,
      name: req.realName,
      version,
      entry,
      integrity,
      children: [],
      peerSpecs: peerSpecsOf(entry).map((peer) => ({
        ...peer,
        range: this.overrides.select(override.context, peer.name, peer.range)
          .spec,
      })),
      peerBindings: new Map(),
      chain: hasPeers ? [...chain, parentFrame] : [],
    };
    if (!hasPeers) this.peerless.set(memoKey, occ);
    else this.peerBearing.get(parentFrame)?.set(memoKey, occ);
    this.occurrences.push(occ);

    const selfFrame: Frame = {
      label: baseKey,
      children: occ.children,
      overrideContext: override.context,
    };
    const childChain = [...chain, parentFrame];
    for (const dep of regularDepsOf(entry)) {
      const child = await this.buildChild(
        selfFrame,
        childChain,
        dep.name,
        dep.spec,
        dep.kind,
      );
      if (child === null) continue;
      occ.children.push({
        edgeName: dep.name,
        kind: dep.kind,
        spec: dep.spec,
        child,
      });
    }
    return occ;
  }

  /**
   * Bind every declared peer against the built tree, iterating until a full
   * round changes nothing. Re-evaluation converges: the tree only grows
   * (fresh auto-selected peers, memoized per requester), and a binding only
   * ever moves to a nearer candidate, so movement is bounded by tree depth.
   */
  async bindPeersToFixpoint(): Promise<void> {
    for (let round = 0; round < this.limits.maxPeerRounds; round += 1) {
      this.checkBudget();
      let changed = false;
      for (const occ of this.occurrences) {
        for (const spec of occ.peerSpecs) {
          if (await this.bindOne(occ, spec)) changed = true;
        }
      }
      if (!changed) return;
    }
    throw budgetError("peer binding iteration limit exceeded");
  }

  /**
   * One binding attempt. Returns true when the binding moved, a fresh node
   * was created, or an absent optional was recorded.
   */
  private async bindOne(occ: Occurrence, spec: PeerSpec): Promise<boolean> {
    this.checkBudget();
    const current = occ.peerBindings.get(spec.name);
    const lookup = lookupPeer(occ, spec.name, spec.range);
    if (lookup.status === "conflict") {
      throw peerConflict(occ, spec, lookup.found);
    }
    if (lookup.status === "absent") {
      if (spec.optional) {
        if (current === undefined) {
          occ.peerBindings.set(spec.name, null);
          return true;
        }
        if (current !== null)
          throw internal(`optional peer ${spec.name} lost its binding`);
        return false;
      }
      const fresh = await this.freshPeer(occ, spec);
      return this.attachPeer(occ, spec, fresh);
    }
    return this.attachPeer(occ, spec, lookup.target);
  }

  /** Point a peer edge at its target, replacing any superseded peer link. */
  private attachPeer(
    occ: Occurrence,
    spec: PeerSpec,
    target: Occurrence,
  ): boolean {
    const linked = occ.children.some(
      (link) => link.edgeName === spec.name && link.child === target,
    );
    if (occ.peerBindings.get(spec.name) === target && linked) return false;
    occ.peerBindings.set(spec.name, target);
    for (let index = occ.children.length - 1; index >= 0; index -= 1) {
      const link = occ.children[index];
      if (link?.kind === "peer" && link.edgeName === spec.name)
        occ.children.splice(index, 1);
    }
    occ.children.push({
      edgeName: spec.name,
      kind: "peer",
      spec: spec.range,
      child: target,
    });
    return true;
  }

  /**
   * Auto-select a missing required peer (SPEC 9.3): resolve it fresh under
   * the requesting occurrence. Memoized per requester so the tree stays
   * finite; the fresh subtree binds against the growing tree in later
   * rounds.
   */
  private async freshPeer(
    occ: Occurrence,
    spec: PeerSpec,
  ): Promise<Occurrence> {
    let perOcc = this.freshPeers.get(occ);
    if (perOcc === undefined) {
      perOcc = new Map();
      this.freshPeers.set(occ, perOcc);
    }
    const existing = perOcc.get(spec.name);
    if (existing !== undefined) return existing;
    const override = this.overrides.select(
      occ.overrideContext,
      spec.name,
      spec.range,
    );
    const req = parseRequirement(spec.name, override.spec);
    const { version, entry } = await selectVersion(this, {
      realName: req.realName,
      targetSpec: req.targetSpec,
      targetKind: req.targetKind,
    });
    const integrity = expectedIntegrityFromDist(entry.dist);
    if (integrity === undefined) {
      throw new ZyrkError(
        "ZYRK_INTEGRITY_FAILED",
        `registry metadata for ${req.realName}@${version} carries no integrity digest`,
        {
          detail: { name: req.realName, version },
          remedy:
            "strict policy rejects unpinned archives; configure the origin-verification policy explicitly to accept and pin one",
        },
      );
    }
    this.checkPlatform(req.realName, entry);
    this.checkBudget(occ.chain.length + 1, true);
    const fresh: Occurrence = {
      overrideContext: override.context,
      name: req.realName,
      version,
      entry,
      integrity,
      children: [],
      peerSpecs: peerSpecsOf(entry).map((peer) => ({
        ...peer,
        range: this.overrides.select(override.context, peer.name, peer.range)
          .spec,
      })),
      peerBindings: new Map(),
      chain: [...occ.chain, this.frameOf(occ)],
    };
    perOcc.set(spec.name, fresh);
    this.occurrences.push(fresh);
    const selfFrame = this.frameOf(fresh);
    for (const dep of regularDepsOf(entry)) {
      const child = await this.buildChild(
        selfFrame,
        fresh.chain,
        dep.name,
        dep.spec,
        dep.kind,
      );
      if (child === null) continue;
      fresh.children.push({
        edgeName: dep.name,
        kind: dep.kind,
        spec: dep.spec,
        child,
      });
    }
    return fresh;
  }

  private readonly frames = new Map<Occurrence, Frame>();

  /** Stable lookup frame for an occurrence (live children view). */
  private frameOf(occ: Occurrence): Frame {
    let frame = this.frames.get(occ);
    if (frame === undefined) {
      frame = {
        label: `${occ.name}@${occ.version}`,
        children: occ.children,
        overrideContext: occ.overrideContext,
      };
      this.frames.set(occ, frame);
    }
    return frame;
  }

  /**
   * Final deterministic keys, merge checks, reachability pruning, and output
   * records. Unreachable occurrences (superseded peer links leave their old
   * targets behind) are dropped so the document is exactly the reachable
   * closure of the requirements.
   */
  finalize(
    rootLinks: Array<{ name: string; child: Occurrence }>,
  ): FinalizedGraph {
    const keys = new Map<Occurrence, string>();
    for (const occ of this.occurrences) {
      this.checkBudget();
      keys.set(
        occ,
        occurrenceKey(occ, (depth) => {
          this.checkBudget(depth);
          if (++this.peerExpansions > this.limits.maxPeerExpansions)
            throw budgetError("peer expansion limit exceeded");
        }),
      );
    }
    const reachable = new Set<Occurrence>();
    const pending = rootLinks.map((link) => link.child);
    for (;;) {
      const occ = pending.pop();
      if (!occ) break;
      this.checkBudget();
      if (reachable.has(occ)) continue;
      reachable.add(occ);
      for (const link of occ.children) pending.push(link.child);
    }
    const byKey = new Map<string, Occurrence>();
    for (const occ of reachable) {
      const key = keys.get(occ);
      if (key === undefined) throw internal("missing finalized key");
      const existing = byKey.get(key);
      if (existing !== undefined) {
        assertMergeable(
          existing,
          occ,
          keys,
          this.provider.originFor?.(occ.name) ?? this.provider.origin,
        );
        continue;
      }
      byKey.set(key, occ);
    }
    const nodes = [...byKey.entries()]
      .sort((a, b) => compareStrings(a[0], b[0]))
      .map(([key, occ]) =>
        toResolved(
          occ,
          key,
          keys,
          this.provider.originFor?.(occ.name) ?? this.provider.origin,
        ),
      );
    const roots = rootLinks.map((link) => {
      const target = keys.get(link.child);
      if (target === undefined)
        throw internal(`missing key for root ${link.name}`);
      return { name: link.name, target };
    });
    return {
      nodes,
      roots,
      ...(this.omissions.length ? { omissions: this.omissions } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Version selection
// ---------------------------------------------------------------------------

async function selectVersion(
  state: ResolverState,
  req: {
    realName: string;
    targetSpec: string;
    targetKind: "exact" | "range" | "tag";
  },
): Promise<{ version: string; entry: PackumentVersion }> {
  if (req.targetKind === "exact" && state.provider.versionManifest) {
    try {
      return {
        version: req.targetSpec,
        entry: await state.versionManifestOf(req.realName, req.targetSpec),
      };
    } catch (error) {
      // Registries and older test adapters may expose only packuments. Keep
      // the optimization opportunistic when the exact endpoint is absent.
      if (!(error instanceof ZyrkError) || error.detail?.status !== 404) {
        throw error;
      }
    }
  }
  const packument = await state.packumentOf(req.realName);
  const fail = (message: string, remedy: string): ZyrkError =>
    new ZyrkError("ZYRK_RESOLUTION_FAILED", message, {
      detail: { name: req.realName, spec: req.targetSpec },
      remedy,
    });
  switch (req.targetKind) {
    case "exact": {
      const entry = packument.versions[req.targetSpec];
      if (entry === undefined) {
        throw fail(
          `registry has no version ${req.targetSpec} of ${req.realName}`,
          "check the requested version exists in the configured registry",
        );
      }
      return { version: req.targetSpec, entry };
    }
    case "tag": {
      const target = packument.distTags[req.targetSpec];
      if (target === undefined) {
        throw fail(
          `registry has no dist-tag ${req.targetSpec} for ${req.realName}`,
          "check the tag name or use an exact version",
        );
      }
      const entry = packument.versions[target];
      if (entry === undefined) {
        throw fail(
          `dist-tag ${req.targetSpec} of ${req.realName} points at missing version ${target}`,
          "report the registry response; tags must resolve to published versions",
        );
      }
      return { version: target, entry };
    }
    case "range": {
      const candidates = Object.keys(packument.versions).filter(
        (v) => valid(v) !== null,
      );
      const version = maxSatisfying(candidates, req.targetSpec);
      if (version === null) {
        throw fail(
          `no version of ${req.realName} satisfies ${req.targetSpec}`,
          "relax the range or check which versions the registry publishes",
        );
      }
      const entry = packument.versions[version];
      if (entry === undefined)
        throw internal(`selected version ${version} vanished`);
      return { version, entry };
    }
  }
}

// ---------------------------------------------------------------------------
// Peer lookup and fingerprints
// ---------------------------------------------------------------------------

type LookupResult =
  | { status: "bound"; target: Occurrence }
  | { status: "absent" }
  | { status: "conflict"; found: Array<{ version: string; via: string }> };

/**
 * Nearest-first peer lookup from the requesting occurrence outward: its own
 * children, then each chain frame's children innermost-first. A same-named
 * but incompatible candidate is a conflict, never a reason to look further
 * out (SPEC 9.3 fails incompatible required sets by default).
 */
function lookupPeer(
  occ: Occurrence,
  peerName: string,
  range: string,
): LookupResult {
  const levels: Array<{ label: string; children: ChildLink[] }> = [
    { label: `${occ.name}@${occ.version}`, children: occ.children },
    ...[...occ.chain].reverse(),
  ];
  for (const level of levels) {
    const matches = level.children.filter((link) => link.edgeName === peerName);
    if (matches.length === 0) continue;
    const requested = parseRequirement(peerName, range);
    const satisfying = matches.filter(
      (link) =>
        link.child.name === requested.realName &&
        (requested.targetKind === "tag" ||
          satisfies(link.child.version, requested.targetSpec)),
    );
    const first = satisfying[0];
    if (first !== undefined) return { status: "bound", target: first.child };
    return {
      status: "conflict",
      found: matches.map((link) => ({
        version: link.child.version,
        via: level.label,
      })),
    };
  }
  return { status: "absent" };
}

function peerConflict(
  occ: Occurrence,
  spec: PeerSpec,
  found: Array<{ version: string; via: string }>,
): ZyrkError {
  const chain = [
    ...occ.chain.map((frame) => frame.label),
    `${occ.name}@${occ.version}`,
  ];
  return new ZyrkError(
    "ZYRK_PEER_CONFLICT",
    `incompatible peer ${spec.name}@${spec.range} required by ${occ.name}@${occ.version}`,
    {
      detail: {
        chain,
        peer: spec.name,
        range: spec.range,
        found: found.map((entry) => `${entry.version} via ${entry.via}`),
      },
      remedy: "align the versions or declare an intentional override",
    },
  );
}

/** Canonical fingerprint over the transitive peer closure (SPEC 9.4). */
function occurrenceKey(
  occ: Occurrence,
  check: (depth: number) => void,
): string {
  const base = `${occ.name}@${occ.version}`;
  if (occ.peerSpecs.length === 0 && !occ.overrideContext.id) return base;
  const expansion = expandPeerBindings(occ, new Set<Occurrence>([occ]), check);
  return `${base}#${sha512Hex(canonicalJson(occ.overrideContext.id ? [occ.overrideContext.id, expansion] : expansion)).slice(0, 12)}`;
}

function expandPeerBindings(
  occ: Occurrence,
  visiting: Set<Occurrence>,
  check: (depth: number) => void,
): unknown {
  check(visiting.size);
  const parts: Array<[string, unknown]> = [];
  for (const spec of occ.peerSpecs) {
    check(visiting.size);
    const bound = occ.peerBindings.get(spec.name);
    if (bound === undefined)
      throw internal(`unbound peer ${spec.name} at finalization`);
    if (bound === null) {
      parts.push([spec.name, "absent"]);
    } else if (visiting.has(bound)) {
      parts.push([
        spec.name,
        [
          "ref",
          bound.overrideContext.id
            ? [`${bound.name}@${bound.version}`, bound.overrideContext.id]
            : `${bound.name}@${bound.version}`,
        ],
      ]);
    } else {
      parts.push([
        spec.name,
        [
          "node",
          bound.overrideContext.id
            ? [`${bound.name}@${bound.version}`, bound.overrideContext.id]
            : `${bound.name}@${bound.version}`,
          expandPeerBindings(bound, new Set([...visiting, bound]), check),
        ],
      ]);
    }
  }
  return parts;
}

function assertMergeable(
  a: Occurrence,
  b: Occurrence,
  keys: Map<Occurrence, string>,
  origin: string,
): void {
  const sourceA = sourceIdForOccurrence(a, origin);
  const sourceB = sourceIdForOccurrence(b, origin);
  if (sourceA !== sourceB) {
    throw new ZyrkError(
      "ZYRK_RESOLUTION_FAILED",
      `same occurrence key selects different sources for ${a.name}@${a.version}`,
      {
        detail: { key: keys.get(a), sources: [sourceA, sourceB] },
        remedy:
          "a public and a private registry publishing the same name/version are not the same trusted identity",
      },
    );
  }
  const edgesA = canonicalJson(
    a.children.map((link) => [link.edgeName, keys.get(link.child)]),
  );
  const edgesB = canonicalJson(
    b.children.map((link) => [link.edgeName, keys.get(link.child)]),
  );
  if (edgesA !== edgesB) {
    throw internal(
      `same occurrence key with different edges for ${a.name}@${a.version}`,
    );
  }
}

function toResolved(
  occ: Occurrence,
  key: string,
  keys: Map<Occurrence, string>,
  origin: string,
): ResolvedOccurrence {
  const engines =
    occ.entry.engines === undefined
      ? undefined
      : normalizeEngineConstraints(occ.entry.engines, () => {
          throw new ZyrkError(
            "ZYRK_RESOLUTION_FAILED",
            `Cannot resolve ${occ.name}: invalid engine constraints.`,
            {
              remedy:
                "Select a package version with valid npm engine metadata.",
            },
          );
        });
  const edgesByName = new Map<string, ResolvedEdge>();
  for (const link of occ.children) {
    const target = keys.get(link.child);
    if (target === undefined) throw internal(`missing key for child of ${key}`);
    const previous = edgesByName.get(link.edgeName);
    if (previous && previous.target !== target)
      throw new ZyrkError(
        "ZYRK_PEER_CONFLICT",
        `Dependency and peer bindings disagree for ${occ.name}'s ${link.edgeName}.`,
        { remedy: "Align the declared dependency and peer requirements." },
      );
    if (!previous || previous.kind === "peer")
      edgesByName.set(link.edgeName, {
        name: link.edgeName,
        target,
        kind: link.kind,
        spec: link.spec,
      });
  }
  const edges = [...edgesByName.values()];
  const peerBindings = occ.peerSpecs.map((spec) => {
    const bound = occ.peerBindings.get(spec.name);
    if (bound === undefined)
      throw internal(`unbound peer ${spec.name} of ${key}`);
    if (bound === null)
      return { name: spec.name, target: null, optional: true };
    const target = keys.get(bound);
    if (target === undefined) throw internal(`missing key for peer of ${key}`);
    return {
      name: spec.name,
      target,
      ...(spec.optional ? { optional: true } : {}),
    };
  });
  return {
    key,
    name: occ.name,
    version: occ.version,
    sourceId: sourceIdForOccurrence(occ, origin),
    integrity: occ.integrity,
    origin,
    tarballUrl: occ.entry.dist.tarball,
    bin: normalizeBin(occ.name, occ.entry.bin),
    edges,
    peerBindings,
    platform: {
      ...(occ.entry.os === undefined ? {} : { os: occ.entry.os }),
      ...(occ.entry.cpu === undefined ? {} : { cpu: occ.entry.cpu }),
      ...(occ.entry.libc === undefined ? {} : { libc: occ.entry.libc }),
    },
    ...(engines === undefined ? {} : { engines }),
  };
}

function sourceIdForOccurrence(occ: Occurrence, origin: string): string {
  return sourceIdOf({
    sourceType: "registry",
    name: occ.name,
    version: occ.version,
    origin,
    integrity: occ.integrity,
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function peerSpecsOf(entry: PackumentVersion): PeerSpec[] {
  return Object.keys(entry.peerDependencies ?? {})
    .sort(compareStrings)
    .map((peerName) => ({
      name: peerName,
      range: entry.peerDependencies?.[peerName] ?? "*",
      optional: entry.peerDependenciesMeta?.[peerName]?.optional === true,
    }));
}

function regularDepsOf(
  entry: PackumentVersion,
): Array<{ name: string; spec: string; kind: "prod" | "optional" }> {
  const bundled = new Set<string>();
  if (Array.isArray(entry.bundledDependencies)) {
    for (const name of entry.bundledDependencies) bundled.add(name);
  }
  const bundleAll = entry.bundledDependencies === true;
  const seen = new Set<string>();
  const deps: Array<{ name: string; spec: string; kind: "prod" | "optional" }> =
    [];
  const push = (
    name: string,
    spec: string,
    kind: "prod" | "optional",
  ): void => {
    if (seen.has(name) || bundled.has(name) || bundleAll) return;
    seen.add(name);
    deps.push({ name, spec, kind });
  };
  for (const name of Object.keys(entry.dependencies ?? {})
    .filter((name) => !Object.hasOwn(entry.optionalDependencies ?? {}, name))
    .sort(compareStrings)) {
    push(name, entry.dependencies?.[name] ?? "", "prod");
  }
  for (const name of Object.keys(entry.optionalDependencies ?? {}).sort(
    compareStrings,
  )) {
    push(name, entry.optionalDependencies?.[name] ?? "", "optional");
  }
  return deps;
}

function normalizeBin(
  name: string,
  bin: PackumentVersion["bin"],
): Record<string, string> {
  if (typeof bin === "string") {
    const short = name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
    return { [short]: bin };
  }
  if (typeof bin !== "object" || bin === null) return {};
  const out: Record<string, string> = {};
  for (const [binName, target] of Object.entries(bin)) {
    if (typeof target === "string") out[binName] = target;
  }
  return out;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function internal(message: string): ZyrkError {
  return new ZyrkError("ZYRK_INTERNAL", message);
}

function budgetError(reason: string): ZyrkError {
  return new ZyrkError(
    "ZYRK_RESOLUTION_FAILED",
    `Cannot resolve dependencies (${reason}).`,
    {
      remedy:
        "Review the dependency graph. For a slow registry, set ZYRK_RESOLVE_TIMEOUT_MS to at most 900000 milliseconds before retrying; graph limits remain enforced.",
    },
  );
}
class PlatformMismatch extends ZyrkError {
  constructor(name: string) {
    super(
      "ZYRK_RESOLUTION_FAILED",
      `Cannot select ${name} on the current platform.`,
      {
        remedy:
          "Use a compatible operating system, architecture and libc, or choose a compatible package version.",
      },
    );
  }
}
