import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  readdir,
  stat,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { Store } from "../src/store/layout.ts";
import { createGraphDoc } from "../src/store/graph.ts";
import {
  approveCandidate,
  materializePrivate,
  candidates,
  buildPrivate,
} from "../src/install/private.ts";
import { installProject } from "../src/install/run.ts";
import { resolveRequirements } from "../src/resolve/resolver.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";
import { pathExists, rmrfNoFollow } from "../src/util/fsx.ts";
let root: string,
  project: string,
  store: Store,
  server: StubRegistry | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-private-security-"));
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rmrfNoFollow(root);
});

it("rejects a linked generations parent before creating any outside files", async () => {
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await mkdir(path.join(project, ".zyrk-local"));
  await symlink(outside, path.join(project, ".zyrk-local/generations"));
  await expect(
    materializePrivate({
      project,
      store,
      graph: createGraphDoc([]),
      generationId: "gen1_security",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(await readdir(outside)).toEqual([]);
});

it("exclusively creates a generation and rejects path-shaped identities", async () => {
  const graph = createGraphDoc([]);
  await materializePrivate({
    project,
    store,
    graph,
    generationId: "gen1_security",
  });
  const sentinel = path.join(
    project,
    ".zyrk-local/generations/gen1_security/sentinel",
  );
  await writeFile(sentinel, "unchanged");
  await expect(
    materializePrivate({
      project,
      store,
      graph,
      generationId: "gen1_security",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  await expect(
    materializePrivate({
      project,
      store,
      graph,
      generationId: "../../outside",
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
});

it("materializes and builds one physical context for duplicate npm-style occurrences", async () => {
  server = await startStubRegistry([
    {
      name: "builder",
      versions: [
        {
          version: "1.0.0",
          deps: { leaf: "1.0.0" },
          scripts: { postinstall: "node build.js" },
          files: {
            "index.js": { data: 'module.exports=require("leaf");' },
            "build.js": {
              data: 'const fs=require("fs");fs.appendFileSync("count.txt","built\\n");',
            },
          },
        },
      ],
    },
    {
      name: "leaf",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports={singleton:true};" } },
        },
      ],
    },
  ]);
  const registry = new RegistryClient({
    registry: server.url,
    userAgent: "test",
  });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ dependencies: { builder: "1.0.0" } }),
  );
  await installProject({
    projectDir: project,
    store,
    registry,
    fetchOnly: true,
  });
  const resolved = await resolveRequirements({
    provider: registry,
    requirements: [{ name: "builder", spec: "1.0.0" }],
  });
  const original = resolved.nodes.find((node) => node.name === "builder")!;
  const duplicate = {
    ...original,
    key: `${original.name}@${original.version}#deadbeef`,
  };
  const nodes = [...resolved.nodes, duplicate];
  const graph = createGraphDoc(
    nodes.map((node) => ({ ...node, deps: node.edges })),
  );
  const realized = await materializePrivate({
    project,
    store,
    graph,
    generationId: "gen1_duplicate",
  });
  const directory = realized.packageDirByKey.get(original.key)!;
  expect(realized.packageDirByKey.get(duplicate.key)).toBe(directory);
  expect(realized.created).toHaveLength(2);
  const builds = await candidates(nodes, realized.packageDirByKey);
  expect(builds).toHaveLength(1);
  // Execution also deduplicates defensively when a caller supplies duplicate candidates.
  await buildPrivate({
    project,
    generationId: "gen1_duplicate",
    nodes,
    builds: [...builds, { ...builds[0]!, key: duplicate.key }],
    realized,
    env: process.env,
  });
  expect(await readFile(path.join(directory, "count.txt"), "utf8")).toBe(
    "built\n",
  );
  expect((await stat(path.join(directory, "index.js"))).nlink).toBe(1);
});

it("mandatory denials prevent approval metadata publication", async () => {
  const config = path.join(root, "config");
  await mkdir(path.join(config, "zyrk"), { recursive: true });
  await writeFile(
    path.join(config, "zyrk/config.json"),
    JSON.stringify({ scripts: { deny: ["builder"] } }),
  );
  const builds = [
    {
      key: "builder@1.0.0",
      name: "builder",
      version: "1.0.0",
      sourceId: "src1_test",
      stages: [{ name: "install", command: "exit 0" }],
    },
  ];
  await expect(
    approveCandidate({
      project,
      digest: "reviewed",
      builds,
      selected: ["*"],
      env: { ...process.env, XDG_CONFIG_HOME: config },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(
    await pathExists(path.join(project, ".zyrk-local/approvals.json")),
  ).toBe(false);
  await expect(
    approveCandidate({
      project,
      digest: "reviewed",
      builds,
      selected: ["*"],
      policy: { unrecognized: true },
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(
    await pathExists(path.join(project, ".zyrk-local/approvals.json")),
  ).toBe(false);
});
