import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import { validateWorkspaceLockDoc } from "../src/install/workspace-lock.ts";
import {
  recoverWorkspaceProjection,
  publishWorkspaceProjection,
  workspaceProjectionPaths,
} from "../src/install/workspace-transaction.ts";
import { ZYRK_RESOLVER_POLICY } from "../src/lockfile/types.ts";
import { CONTEXT_CANONICALIZATION_VERSION } from "../src/version.ts";
import { sourceIdOf } from "../src/util/hash.ts";
let root: string;
const generation = "gen1_abc234";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zyrk-ws-review-"));
  await mkdir(path.join(root, ".zyrk-local"));
  await mkdir(path.join(root, "packages/a"), { recursive: true });
});
afterEach(async () => {
  await rmrfNoFollow(root);
});
function validLock() {
  return {
    lockfileVersion: 3,
    zyrk: {
      version: 2,
      resolver: ZYRK_RESOLVER_POLICY,
      contextCanonicalization: CONTEXT_CANONICALIZATION_VERSION,
      manifest: "a".repeat(128),
      scripts: "sha512-" + "A".repeat(86) + "==",
      config: "sha512-" + "A".repeat(86) + "==",
      nodes: {},
      roots: {},
      workspaceGraph: {
        nodes: [
          {
            kind: "local",
            key: "workspace:.",
            name: "root",
            version: "1.0.0",
            importer: ".",
            edges: [
              {
                name: "a",
                target: "workspace:packages/a",
                kind: "prod",
                spec: "workspace:*",
              },
            ],
            peers: {},
            optionalPeers: [],
          },
          {
            kind: "local",
            key: "workspace:packages/a",
            name: "a",
            version: "1.0.0",
            importer: "packages/a",
            edges: [],
            peers: {},
            optionalPeers: [],
          },
        ],
        importers: { ".": "workspace:.", "packages/a": "workspace:packages/a" },
        omissions: [],
      },
    },
  };
}
test("workspace schema rejects unknown extension, graph, node and edge fields", () => {
  expect(validateWorkspaceLockDoc(validLock()).nodes).toHaveLength(2);
  const mutations = [
    (d: any) => {
      d.zyrk.newPolicy = true;
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nativeAdapter = true;
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[0].sourceId = "source1_fake";
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[0].edges[0].trusted = true;
    },
    (d: any) => {
      d.zyrk.scripts = "unbound";
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[1].importer = "../escape";
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[0].edges[0].target = "missing";
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[0].edges[0].name = "../escape";
    },
    (d: any) => {
      d.zyrk.workspaceGraph.nodes[0].edges[0].spec =
        "https://user:secret@example.test/";
    },
  ];
  for (const mutate of mutations) {
    const doc = validLock();
    mutate(doc);
    expect(() => validateWorkspaceLockDoc(doc)).toThrow(
      expect.objectContaining({ code: "ZYRK_LOCK_MISMATCH" }),
    );
  }
});
async function marker(directory: string, contents: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "marker"), contents);
}
async function journal(value: unknown) {
  await writeFile(
    path.join(root, ".zyrk-local/workspace-journal.json"),
    JSON.stringify(value),
  );
}
function decision(committed = false) {
  return {
    version: 1,
    generationId: generation,
    committed,
    lockBefore: "old-lock",
    lockAfter: "new-lock",
    importers: [
      { id: ".", hadBefore: true },
      { id: "packages/a", hadBefore: true },
    ],
  };
}
test("recovery rolls back a crash between importer swaps and lock publication", async () => {
  const top = workspaceProjectionPaths(root, ".", generation);
  const child = workspaceProjectionPaths(root, "packages/a", generation);
  await marker(top.previous, "old-root");
  await marker(top.active, "new-root");
  await marker(child.previous, "old-child");
  await marker(child.staged, "new-child");
  await writeFile(path.join(root, "package-lock.json"), "new-lock");
  await journal(decision());
  await recoverWorkspaceProjection(root);
  expect(await readFile(path.join(top.active, "marker"), "utf8")).toBe(
    "old-root",
  );
  expect(await readFile(path.join(child.active, "marker"), "utf8")).toBe(
    "old-child",
  );
  expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
    "old-lock",
  );
  await recoverWorkspaceProjection(root);
});
test("a durable commit decision preserves all new importers and the new lock", async () => {
  for (const id of [".", "packages/a"]) {
    const p = workspaceProjectionPaths(root, id, generation);
    await marker(p.active, "new");
    await marker(p.previous, "old");
  }
  await writeFile(path.join(root, "package-lock.json"), "old-lock");
  await journal(decision(true));
  await recoverWorkspaceProjection(root);
  for (const id of [".", "packages/a"]) {
    const p = workspaceProjectionPaths(root, id, generation);
    expect(await readFile(path.join(p.active, "marker"), "utf8")).toBe("new");
    await expect(lstat(p.previous)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
    "new-lock",
  );
});
test("failed publication restores root and child projections and the authoritative lock", async () => {
  const top = workspaceProjectionPaths(root, ".", generation);
  const child = workspaceProjectionPaths(root, "packages/a", generation);
  await marker(top.active, "old-root");
  await marker(top.staged, "new-root");
  await marker(child.active, "old-child"); // missing staged child injects the failure
  await writeFile(path.join(root, "package-lock.json"), "old-lock");
  await expect(
    publishWorkspaceProjection(
      root,
      generation,
      [".", "packages/a"],
      "new-lock",
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(top.active, "marker"), "utf8")).toBe(
    "old-root",
  );
  expect(await readFile(path.join(child.active, "marker"), "utf8")).toBe(
    "old-child",
  );
  expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
    "old-lock",
  );
});
test("unsafe journal importers cannot mutate projections outside the workspace", async () => {
  const sentinel = path.join(root, "outside");
  await marker(sentinel, "keep");
  await symlink(sentinel, path.join(root, "linked"));
  for (const id of [
    "../escape",
    "/tmp/escape",
    "linked/child",
    ".git",
    "node_modules/child",
    ".zyrk-local/child",
  ]) {
    await journal({
      ...decision(),
      importers: [
        { id: ".", hadBefore: true },
        { id, hadBefore: false },
      ],
    });
    await expect(recoverWorkspaceProjection(root)).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
    expect(await readFile(path.join(sentinel, "marker"), "utf8")).toBe("keep");
  }
});

test("unknown journal fields and missing root importer fail before deleting active data", async () => {
  const active = workspaceProjectionPaths(root, ".", generation).active;
  await marker(active, "keep");
  for (const malformed of [
    { ...decision(), futurePolicy: true },
    { ...decision(), importers: [] },
    { ...decision(), generationId: "gen1_../../escape" },
    {
      ...decision(),
      importers: [{ id: ".", hadBefore: false, deletionPath: "anything" }],
    },
  ]) {
    await journal(malformed);
    await expect(recoverWorkspaceProjection(root)).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
    expect(await readFile(path.join(active, "marker"), "utf8")).toBe("keep");
  }
});

test("recovery refuses a journal file symlink before applying its deletion decision", async () => {
  const active = workspaceProjectionPaths(root, ".", generation).active;
  await marker(active, "keep");
  const externalJournal = path.join(root, "untrusted.json");
  await writeFile(
    externalJournal,
    JSON.stringify({
      ...decision(),
      importers: [{ id: ".", hadBefore: false }],
    }),
  );
  await symlink(
    externalJournal,
    path.join(root, ".zyrk-local/workspace-journal.json"),
  );
  await expect(recoverWorkspaceProjection(root)).rejects.toMatchObject({
    code: "ZYRK_LOCK_MISMATCH",
  });
  expect(await readFile(path.join(active, "marker"), "utf8")).toBe("keep");
});

test("rollback removes first-install projections and restores an absent lock", async () => {
  for (const id of [".", "packages/a"]) {
    const p = workspaceProjectionPaths(root, id, generation);
    await marker(p.active, "new");
  }
  await writeFile(path.join(root, "package-lock.json"), "new-lock");
  await journal({
    ...decision(),
    lockBefore: null,
    importers: [
      { id: ".", hadBefore: false },
      { id: "packages/a", hadBefore: false },
    ],
  });
  await recoverWorkspaceProjection(root);
  for (const id of [".", "packages/a"]) {
    await expect(
      lstat(workspaceProjectionPaths(root, id, generation).active),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
  await expect(
    lstat(path.join(root, "package-lock.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("workspace registry entries retain strict origin, content identity and executable boundaries", () => {
  const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const identity = {
    sourceType: "registry" as const,
    name: "foo",
    version: "1.0.0",
    origin: "https://registry.example",
    integrity,
  };
  const make = (): any => {
    const doc: any = validLock();
    const key = "foo@1.0.0#abcdef12";
    doc.zyrk.workspaceGraph.nodes[0].edges.push({
      name: "foo",
      target: key,
      kind: "prod",
      spec: "1.0.0",
    });
    doc.zyrk.workspaceGraph.nodes.push({
      ...identity,
      sourceType: undefined,
      kind: "registry",
      key,
      sourceId: sourceIdOf(identity),
      tarballUrl: "https://registry.example/foo.tgz",
      bin: { foo: "cli.js" },
      platform: {},
      edges: [],
      peers: {},
      optionalPeers: [],
    });
    delete doc.zyrk.workspaceGraph.nodes[2].sourceType;
    return doc;
  };
  expect(validateWorkspaceLockDoc(make()).nodes).toHaveLength(3);
  const mutations = [
    (node: any) => {
      node.sourceId = "source1_fake";
    },
    (node: any) => {
      node.origin = "https://user:credential@registry.example";
    },
    (node: any) => {
      node.tarballUrl = "file:///tmp/package.tgz";
    },
    (node: any) => {
      node.bin.foo = "../../escape";
    },
    (node: any) => {
      node.platform.unknown = ["linux"];
    },
    (node: any) => {
      node.buildAdapter = true;
    },
  ];
  for (const mutate of mutations) {
    const doc = make();
    mutate(doc.zyrk.workspaceGraph.nodes[2]);
    expect(() => validateWorkspaceLockDoc(doc)).toThrow(
      expect.objectContaining({ code: "ZYRK_LOCK_MISMATCH" }),
    );
  }
});

test("manifest recovery snapshots remain bound to validated importer paths", async () => {
  const manifest = path.join(root, "package.json");
  await writeFile(manifest, "keep");
  for (const snapshot of [
    { id: "../outside", before: "old", after: "new" },
    { id: "unregistered", before: "old", after: "new" },
    { id: ".", before: "old", after: "new", file: "anything" },
  ]) {
    await journal({ ...decision(), metadataOnly: true, manifests: [snapshot] });
    await expect(recoverWorkspaceProjection(root)).rejects.toMatchObject({
      code: "ZYRK_LOCK_MISMATCH",
    });
    expect(await readFile(manifest, "utf8")).toBe("keep");
  }
});

test("metadata-only recovery chooses matching manifest and lock versions without replacing projections", async () => {
  const active = workspaceProjectionPaths(root, ".", generation).active;
  await marker(active, "selected-projection");
  for (const committed of [false, true]) {
    await writeFile(path.join(root, "package.json"), "interrupted-manifest");
    await writeFile(path.join(root, "package-lock.json"), "interrupted-lock");
    await journal({
      ...decision(committed),
      metadataOnly: true,
      manifests: [{ id: ".", before: "old-manifest", after: "new-manifest" }],
    });
    await recoverWorkspaceProjection(root);
    expect(await readFile(path.join(root, "package.json"), "utf8")).toBe(
      committed ? "new-manifest" : "old-manifest",
    );
    expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe(
      committed ? "new-lock" : "old-lock",
    );
    expect(await readFile(path.join(active, "marker"), "utf8")).toBe(
      "selected-projection",
    );
  }
});
