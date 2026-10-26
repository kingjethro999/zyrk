import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { renderBuildReviews } from "../src/cli/build-approval.ts";
import {
  approveCandidate,
  reviewBuildCandidates,
  type BuildCandidate,
} from "../src/install/private.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";

const source = (digit: string) => `src1_${digit.repeat(40)}`;
const builds: BuildCandidate[] = [
  {
    key: "approved@1.0.0",
    name: "approved",
    version: "1.0.0",
    sourceId: source("a"),
    stages: [{ name: "postinstall", command: "node build.js" }],
  },
  {
    key: "denied@2.0.0",
    name: "denied",
    version: "2.0.0",
    sourceId: source("b"),
    stages: [{ name: "install", command: "node-gyp rebuild" }],
  },
  {
    key: "pending@3.0.0",
    name: "pending",
    version: "3.0.0",
    sourceId: source("c"),
    stages: [
      {
        name: "preinstall",
        command: "node prepare.js --token=https://user:secret@example.test/",
      },
    ],
  },
];

let root = "";

afterEach(async () => {
  if (root) await rmrfNoFollow(root);
  root = "";
});

async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-build-review-"));
  const project = path.join(root, "project");
  const config = path.join(root, "config");
  await mkdir(project);
  await mkdir(path.join(config, "zyrk"), { recursive: true });
  await writeFile(
    path.join(config, "zyrk", "config.json"),
    JSON.stringify({ scripts: { deny: ["denied"] } }),
  );
  await writeFile(
    path.join(project, "zyrk-workspace.json"),
    JSON.stringify({
      schemaVersion: 1,
      approvedBuilds: [
        {
          name: "approved",
          version: "1.0.0",
          sourceId: source("a"),
        },
      ],
    }),
  );
  return {
    project,
    env: { ...process.env, XDG_CONFIG_HOME: config },
  };
}

it("classifies exact-source approvals, mandatory denies, and pending builds", async () => {
  const { project, env } = await fixture();
  const reviews = await reviewBuildCandidates({
    project,
    env,
    digest: "candidate",
    builds,
    policy: undefined,
  });
  expect(
    reviews.map(({ name, decision, policyScope }) => ({
      name,
      decision,
      policyScope,
    })),
  ).toEqual([
    {
      name: "approved",
      decision: "approved",
      policyScope: "workspace-policy",
    },
    { name: "denied", decision: "denied", policyScope: "user-deny" },
    { name: "pending", decision: "pending", policyScope: "none" },
  ]);
});

it("lets an allowed selection persist without overriding an unrelated deny", async () => {
  const { project, env } = await fixture();
  await approveCandidate({
    project,
    env,
    digest: "candidate",
    builds,
    selected: ["pending"],
    portable: true,
  });
  const policy = JSON.parse(
    await readFile(path.join(project, "zyrk-workspace.json"), "utf8"),
  ) as { approvedBuilds: Array<{ name: string }> };
  expect(policy.approvedBuilds.map((item) => item.name)).toEqual([
    "approved",
    "pending",
  ]);
  await expect(
    approveCandidate({
      project,
      env,
      digest: "candidate",
      builds,
      selected: ["denied"],
      portable: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
});

it("rejects all when the selection includes a mandatory deny", async () => {
  const { project, env } = await fixture();
  const before = await readFile(
    path.join(project, "zyrk-workspace.json"),
    "utf8",
  );
  await expect(
    approveCandidate({
      project,
      env,
      digest: "candidate",
      builds,
      selected: ["*"],
      portable: true,
    }),
  ).rejects.toMatchObject({ code: "ZYRK_SCRIPT_BLOCKED" });
  expect(
    await readFile(path.join(project, "zyrk-workspace.json"), "utf8"),
  ).toBe(before);
});

it("renders decisions, persistence, and unsandboxed risk without secrets", async () => {
  const { project, env } = await fixture();
  const output = renderBuildReviews(
    await reviewBuildCandidates({
      project,
      env,
      digest: "candidate",
      builds,
      policy: undefined,
    }),
  );
  expect(output).toContain("APPROVED approved@1.0.0");
  expect(output).toContain("DENIED denied@2.0.0");
  expect(output).toContain("PENDING pending@3.0.0");
  expect(output).toContain("zyrk-workspace.json");
  expect(output).toContain("approval is not a sandbox");
  expect(output).not.toContain("secret");
  expect(output).not.toContain("user:");
});
