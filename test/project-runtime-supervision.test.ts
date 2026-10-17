import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { installProject } from "../src/install/run.ts";
import { RegistryClient } from "../src/fetch/registry.ts";
import { openStoreDb } from "../src/store/db.ts";
import { Store } from "../src/store/layout.ts";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import { acquireLock } from "../src/util/locks.ts";
import { superviseChild } from "../src/util/proc.ts";
import { startStubRegistry } from "./helpers/registry-stub.ts";

const moduleUrl = pathToFileURL(path.resolve("src/commands/project.ts")).href;

async function stopped(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

describe.skipIf(process.platform !== "linux")(
  "project runtime process groups and leases",
  () => {
    it.each(["run", "exec"] as const)(
      "bounds targeted cancellation of %s and its descendants",
      async (command) => {
        const root = await mkdtemp(
          path.join(os.tmpdir(), "zyrk-project-runtime-"),
        );
        const project = path.join(root, "project");
        await mkdir(project);
        const store = await Store.open({
          root: path.join(root, "store"),
          create: true,
        });
        const marker = path.join(root, "late-write");
        const leaf = `process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),5000);setInterval(()=>{},100);`;
        const tool = `#!/usr/bin/env node\nconst child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{}); console.log('READY '+process.pid+' '+child.pid);setInterval(()=>{},100);`;
        const server = await startStubRegistry([
          {
            name: "supervised-tool",
            versions: [
              {
                version: "1.0.0",
                bin: { tool: "cli.cjs" },
                files: { "cli.cjs": { data: tool, mode: 0o755 } },
              },
            ],
          },
        ]);
        try {
          await writeFile(
            path.join(project, "package.json"),
            JSON.stringify({
              name: "fixture",
              version: "1.0.0",
              dependencies: { "supervised-tool": "1.0.0" },
              scripts: { tool: "tool" },
            }),
          );
          await installProject({
            store,
            projectDir: project,
            registry: new RegistryClient({
              registry: server.url,
              userAgent: "test",
            }),
          });
          for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const code = `import {runProjectCommand} from ${JSON.stringify(moduleUrl)};process.exitCode=await runProjectCommand({command:${JSON.stringify(command)},args:['tool'],cwd:${JSON.stringify(project)},env:{...process.env,ZYRK_STORE_DIR:${JSON.stringify(store.root)},XDG_CONFIG_HOME:${JSON.stringify(path.join(root, "config"))}},stdout:process.stdout,stderr:process.stderr});`;
            const wrapper = spawn(
              process.execPath,
              ["--input-type=module", "-e", code],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let output = "",
              errors = "";
            wrapper.stderr.on("data", (chunk: Buffer) => {
              errors += chunk.toString();
            });
            const closed = new Promise<number | null>((resolve) =>
              wrapper.once("exit", resolve),
            );
            let pids: number[] = [];
            try {
              await new Promise<void>((resolve, reject) => {
                const deadline = setTimeout(
                  () =>
                    reject(
                      new Error(`No child readiness: ${output} ${errors}`),
                    ),
                  8000,
                );
                wrapper.stdout.on("data", (chunk: Buffer) => {
                  output += chunk.toString();
                  if (output.includes("READY")) {
                    clearTimeout(deadline);
                    resolve();
                  }
                });
                wrapper.once("exit", () => {
                  clearTimeout(deadline);
                  reject(new Error(`Wrapper exited early: ${errors}`));
                });
              });
              pids = (/READY (\d+) (\d+)/.exec(output)?.slice(1) ?? []).map(
                Number,
              );
              expect(pids).toHaveLength(2);
              const db = openStoreDb(store.paths.dbFile);
              try {
                const lease = db
                  .prepare("SELECT * FROM leases WHERE state='active'")
                  .get();
                expect(lease?.holder_start_id).toEqual(expect.any(String));
                const scope = JSON.parse(String(lease?.scope_json)) as {
                  instances: string[];
                };
                expect(scope.instances.length).toBeGreaterThan(0);
                expect(
                  db
                    .prepare("SELECT instance_id FROM generation_instances")
                    .all()
                    .map((row) => row.instance_id)
                    .sort(),
                ).toEqual([...scope.instances].sort());
              } finally {
                db.close();
              }
              wrapper.kill("SIGSTOP");
              try {
                await expect(
                  acquireLock(
                    path.join(store.paths.locksDir, "liveness.lock"),
                    { name: "collector", timeoutMs: 0 },
                  ),
                ).rejects.toMatchObject({ code: "ZYRK_PROJECT_LOCKED" });
              } finally {
                wrapper.kill("SIGCONT");
              }
              wrapper.kill(signal);
              expect(await closed).toBe(signal === "SIGINT" ? 130 : 143);
              for (const pid of pids) expect(await stopped(pid)).toBe(true);
              await expect(readFile(marker)).rejects.toMatchObject({
                code: "ENOENT",
              });
              const after = openStoreDb(store.paths.dbFile);
              try {
                expect(
                  after
                    .prepare("SELECT * FROM leases WHERE state='active'")
                    .all(),
                ).toHaveLength(0);
                expect(
                  after
                    .prepare("SELECT * FROM roots WHERE state='active'")
                    .all(),
                ).toHaveLength(1);
              } finally {
                after.close();
              }
              const held = await acquireLock(
                path.join(store.paths.locksDir, "liveness.lock"),
                { name: "collector", timeoutMs: 0 },
              );
              await held.release();
            } finally {
              wrapper.kill("SIGKILL");
              for (const pid of pids) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  /* Already stopped. */
                }
              }
            }
          }
        } finally {
          await server.close();
          await rmrfNoFollow(root);
        }
      },
      20000,
    );

    it("streams caller output sinks without retaining captured buffers", async () => {
      let stdout = "",
        stderr = "";
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const before = signals.map((signal) => process.listenerCount(signal));
      const result = await superviseChild(
        process.execPath,
        ["-e", "console.log('out');console.error('err')"],
        {
          stdout: {
            write(chunk) {
              stdout += chunk;
            },
          },
          stderr: {
            write(chunk) {
              stderr += chunk;
            },
          },
        },
      );
      expect(stdout).toBe("out\n");
      expect(stderr).toBe("err\n");
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
        before,
      );
    });
  },
);
