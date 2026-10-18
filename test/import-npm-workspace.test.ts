import { expect, it } from "vitest";
import { importNpmWorkspaceLock } from "../src/install/import-npm-workspace.ts";
import type { WorkspaceProject } from "../src/install/workspaces.ts";
const origin = "https://registry.npmjs.org/";
const integrity = "sha512-" + Buffer.alloc(64, 1).toString("base64");
function fixture() {
  const manifest = {
    name: "root",
    version: "1.0.0",
    optionalDependencies: { unavailable: "1.0.0" },
  };
  const project: WorkspaceProject = {
    root: "/unused",
    manifestFingerprint: "unused",
    importers: [
      {
        id: ".",
        directory: "/unused",
        source: {
          kind: "live-directory",
          projectContext: "unused",
          importer: ".",
        },
        manifest,
      },
    ],
  };
  const doc = {
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/unavailable": {
        version: "1.0.0",
        resolved: origin + "unavailable.tgz",
        integrity,
        os: ["!" + process.platform],
      },
    },
  };
  return { project, doc };
}
it("omits incompatible optional npm selections while retaining the locked condition", () => {
  const { project, doc } = fixture();
  const graph = importNpmWorkspaceLock(doc, project, origin);
  expect(graph.nodes.map((n) => n.name)).toEqual(["root"]);
  expect(graph.omissions).toEqual([
    { name: "unavailable", parent: "workspace:.", reason: "platform" },
  ]);
});
it("preserves an explicit relative file workspace alias", () => {
  const { project } = fixture();
  project.importers[0]!.manifest = {
    name: "root",
    version: "1.0.0",
    dependencies: { alias: "file:packages/member" },
  };
  project.importers.push({
    id: "packages/member",
    directory: "/unused/packages/member",
    source: {
      kind: "live-directory",
      projectContext: "unused",
      importer: "packages/member",
    },
    manifest: { name: "member", version: "1.0.0" },
  });
  const doc = {
    lockfileVersion: 3,
    packages: {
      "": project.importers[0]!.manifest,
      "packages/member": project.importers[1]!.manifest,
      "node_modules/alias": { link: true, resolved: "packages/member" },
    },
  };
  const graph = importNpmWorkspaceLock(doc, project, origin);
  expect(graph.nodes.find((n) => n.key === "workspace:.")!.edges).toEqual([
    {
      name: "alias",
      target: "workspace:packages/member",
      kind: "prod",
      spec: "file:packages/member",
    },
  ]);
});
it.each([
  "https://user:password@example.com/archive.tgz",
  "https://example.com/archive.tgz?token=hidden",
])(
  "rejects credential-bearing npm archive metadata before translation",
  (resolved) => {
    const { project, doc } = fixture();
    doc.packages["node_modules/unavailable"].resolved = resolved;
    expect(() => importNpmWorkspaceLock(doc, project, origin)).toThrow(
      /unsafe URL/,
    );
  },
);
it("accepts npm v2's redundant legacy workspace link metadata", () => {
  const { project } = fixture();
  project.importers[0]!.manifest = {
    name: "root",
    version: "1.0.0",
    dependencies: { member: "*" },
  };
  project.importers.push({
    id: "packages/member",
    directory: "/unused/packages/member",
    source: {
      kind: "live-directory",
      projectContext: "unused",
      importer: "packages/member",
    },
    manifest: { name: "member", version: "1.0.0" },
  });
  const doc = {
    lockfileVersion: 2,
    packages: {
      "": project.importers[0]!.manifest,
      "packages/member": project.importers[1]!.manifest,
      "node_modules/member": { link: true, resolved: "packages/member" },
    },
    dependencies: { member: { version: "file:packages/member" } },
  };
  expect(importNpmWorkspaceLock(doc, project, origin).nodes).toHaveLength(2);
});
it("accepts an npm importer whose redundant name field is omitted", () => {
  const { project } = fixture();
  project.importers[0]!.manifest = {
    name: "root",
    version: "1.0.0",
    dependencies: { member: "*" },
  };
  project.importers.push({
    id: "packages/member",
    directory: "/unused/packages/member",
    source: {
      kind: "live-directory",
      projectContext: "unused",
      importer: "packages/member",
    },
    manifest: { name: "member", version: "1.0.0" },
  });
  const doc = {
    lockfileVersion: 3,
    packages: {
      "": project.importers[0]!.manifest,
      "packages/member": { version: "1.0.0" },
      "node_modules/member": { link: true, resolved: "packages/member" },
    },
  };
  expect(importNpmWorkspaceLock(doc, project, origin).nodes).toHaveLength(2);
});
it("retains peer bindings when a peer is also a regular dependency", () => {
  const { project } = fixture();
  project.importers[0]!.manifest = {
    name: "root",
    version: "1.0.0",
    dependencies: { plugin: "1.0.0" },
  };
  const doc = {
    lockfileVersion: 3,
    packages: {
      "": project.importers[0]!.manifest,
      "node_modules/plugin": {
        version: "1.0.0",
        resolved: origin + "plugin.tgz",
        integrity,
        dependencies: { host: "1.0.0" },
        peerDependencies: { host: "^1.0.0" },
      },
      "node_modules/host": {
        version: "1.0.0",
        resolved: origin + "host.tgz",
        integrity,
      },
    },
  };
  const graph = importNpmWorkspaceLock(doc, project, origin),
    plugin = graph.nodes.find((n) => n.name === "plugin")!,
    host = graph.nodes.find((n) => n.name === "host")!;
  expect(plugin.peers).toEqual({ host: host.key });
});
