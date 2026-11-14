import { isolateUserConfig } from "./helpers/user-config.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, afterEach, it, expect } from "vitest";
import { runProjectCommand } from "../src/commands/project.ts";
import { installProject } from "../src/install/run.ts";
import { runStoreCommand } from "../src/commands/store.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { Store } from "../src/store/layout.ts";
import { openStoreDb } from "../src/store/db.ts";
import { acquireLock } from "../src/util/locks.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import {
  startStubRegistry,
  type StubRegistry,
} from "./helpers/registry-stub.ts";

let root: string,
  project: string,
  store: Store,
  server: StubRegistry,
  registry: RegistryClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zyrk-session-"));
  await isolateUserConfig(root);
  project = path.join(root, "project");
  await mkdir(project);
  store = await Store.open({ root: path.join(root, "store"), create: true });
  server = await startStubRegistry([
    {
      name: "alpha",
      versions: [
        {
          version: "1.0.0",
          files: { "index.js": { data: "module.exports=1;" } },
        },
      ],
    },
  ]);
  registry = new RegistryClient({
    registry: server.url,
    retries: 0,
    userAgent: "zyrk-test/0",
  });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { alpha: "1.0.0" },
      scripts: {
        // Longer than the 30s store-lock timeout so a held barrier fails.
        sleep: 'node -e "setTimeout(()=>{},32000)"',
        nap: 'node -e "setTimeout(()=>{},800)"',
      },
    }),
  );
  await installProject({ projectDir: project, store, registry });
});
afterEach(async () => {
  await server.close();
  await rmrfNoFollow(root);
});
function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return runProjectCommand({
    command: "run",
    args,
    cwd: project,
    env: { ...process.env, ZYRK_STORE_DIR: store.root, ...extraEnv },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    json: false,
  });
}
async function activeLeaseCount(): Promise<number> {
  const db = openStoreDb(store.paths.dbFile);
  try {
    return db.prepare("SELECT lease_id FROM leases WHERE state='active'").all()
      .length;
  } finally {
    db.close();
  }
}
async function waitForActiveLease(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await activeLeaseCount()) > 0) return;
    await delay(100);
  }
  throw new Error("session lease never became active");
}
const livenessPath = () => path.join(store.paths.locksDir, "liveness.lock");

it("does not hold the store liveness lock while a session runs", async () => {
  const session = run(["sleep"]);
  await waitForActiveLease();
  const probe = await acquireLock(livenessPath(), {
    name: "test probe",
    timeoutMs: 1_000,
  });
  await probe.release();
  expect(await session).toBe(0);
}, 60_000);

it("runs two sessions concurrently in one project", async () => {
  const [a, b] = await Promise.all([run(["sleep"]), run(["sleep"])]);
  expect(a).toBe(0);
  expect(b).toBe(0);
}, 90_000);

it("keeps the generation lease active for the session lifetime", async () => {
  const session = run(["nap"]);
  await waitForActiveLease();
  expect(await activeLeaseCount()).toBe(1);
  expect(await session).toBe(0);
  for (let i = 0; i < 100; i++) {
    if ((await activeLeaseCount()) === 0) return;
    await delay(100);
  }
  throw new Error("lease was not released after the session exited");
}, 30_000);

it("reconciles a dead lease holder before collection but keeps remote leases", async () => {
  const db = openStoreDb(store.paths.dbFile);
  const now = new Date().toISOString();
  try {
    for (const [id, host] of [
      ["lease1_dead", os.hostname()],
      ["lease1_remote", "other-host.invalid"],
    ] as const)
      db.prepare("INSERT INTO leases VALUES (?,?,?,?,?, 'active', ?, ?)").run(
        id,
        99999999,
        null,
        host,
        "{}",
        now,
        now,
      );
  } finally {
    db.close();
  }
  await runStoreCommand({
    command: "store",
    args: ["gc", "--dry-run"],
    store,
    cwd: project,
    json: true,
  });
  const after = openStoreDb(store.paths.dbFile);
  try {
    const states = new Map(
      (
        after.prepare("SELECT lease_id, state FROM leases").all() as {
          lease_id: string;
          state: string;
        }[]
      ).map((row) => [row.lease_id, row.state]),
    );
    expect(states.get("lease1_dead")).toBe("released");
    expect(states.get("lease1_remote")).toBe("active");
  } finally {
    after.close();
  }
}, 30_000);

it("an install proceeds while a session runs on the same project", async () => {
  const session = run(["sleep"]);
  await waitForActiveLease();
  const result = await installProject({ projectDir: project, store, registry });
  expect(result.readiness).toBe("ready");
  expect(await session).toBe(0);
}, 90_000);
