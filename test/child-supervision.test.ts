import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { rmrfNoFollow } from "../src/util/fsx.ts";
import { superviseChild } from "../src/util/proc.ts";

const moduleUrl = (file: string): string =>
  pathToFileURL(path.resolve(file)).href;

describe.skipIf(process.platform !== "linux")(
  "targeted wrapper cancellation",
  () => {
    it.each(["npm", "dlx"] as const)(
      "forwards SIGTERM and SIGINT to %s and cleans leases",
      async (kind) => {
        for (const signal of ["SIGTERM", "SIGINT"] as const) {
          const root = await mkdtemp(
            path.join(os.tmpdir(), "zyrk-supervision-"),
          );
          let output = "";
          const tool = `console.log('READY ' + process.pid); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "late"))}, 'bad'), 1200); setInterval(() => {}, 100);`;
          let code: string;
          if (kind === "npm") {
            await writeFile(
              path.join(root, "npm"),
              `#!${process.execPath}\n${tool}`,
              { mode: 0o755 },
            );
            code = `import { delegateToNpm } from ${JSON.stringify(moduleUrl("src/cli/npm-delegate.ts"))}; process.exitCode = await delegateToNpm({command:'ping',args:[],env:{...process.env,PATH:${JSON.stringify(root)}},stderr:process.stderr});`;
          } else {
            code = `import { runDlx } from ${JSON.stringify(moduleUrl("src/dlx/run.ts"))}; import { Store } from ${JSON.stringify(moduleUrl("src/store/layout.ts"))}; import { RegistryClient } from ${JSON.stringify(moduleUrl("src/fetch/registry.ts"))}; import { startStubRegistry } from ${JSON.stringify(moduleUrl("test/helpers/registry-stub.ts"))}; const server = await startStubRegistry([{name:'cancel-tool',versions:[{version:'1.0.0',bin:{tool:'cli.js'},files:{'cli.js':{data:${JSON.stringify(tool)}}}}]}]); try { const store=await Store.open({root:${JSON.stringify(path.join(root, "store"))},create:true}); process.exitCode=(await runDlx({store,registry:new RegistryClient({registry:server.url,userAgent:'test'}),spec:'cancel-tool'})).exitCode; } finally {await server.close();}`;
          }
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", code],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let errors = "";
          child.stderr.on("data", (data: Buffer) => {
            errors += data.toString();
          });
          const closed = new Promise<number | null>((resolve) =>
            child.once("exit", resolve),
          );
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error(`no readiness: ${output} ${errors}`)),
                8000,
              );
              child.stdout.on("data", (data: Buffer) => {
                output += data.toString();
                if (output.includes("READY")) {
                  clearTimeout(timeout);
                  resolve();
                }
              });
              child.once("exit", () => {
                clearTimeout(timeout);
                reject(new Error(`wrapper exited early: ${errors}`));
              });
            });
            const pid = Number(/READY (\d+)/.exec(output)?.[1]);
            child.kill(signal);
            expect(await closed).toBe(signal === "SIGINT" ? 130 : 143);
            expect(() => process.kill(pid, 0)).toThrow();
            await expect(readFile(path.join(root, "late"))).rejects.toThrow();
            if (kind === "dlx") {
              const { openStoreDb } = await import("../src/store/db.ts");
              const db = openStoreDb(
                path.join(root, "store", "metadata", "state.sqlite"),
              );
              try {
                expect(
                  db.prepare("SELECT * FROM leases WHERE state='active'").all(),
                ).toHaveLength(0);
                expect(
                  db.prepare("SELECT * FROM roots WHERE state='active'").all(),
                ).toHaveLength(0);
              } finally {
                db.close();
              }
            }
          } finally {
            child.kill("SIGKILL");
            await rmrfNoFollow(root);
          }
        }
      },
      25000,
    );

    it("escalates when a child ignores cancellation", async () => {
      const tool =
        "process.on('SIGTERM',()=>{}); console.log('READY '+process.pid); setInterval(()=>{},100);";
      const code = `import {superviseChild} from ${JSON.stringify(moduleUrl("src/util/proc.ts"))}; process.exitCode=(await superviseChild(process.execPath,['-e',${JSON.stringify(tool)}],{escalationMs:50})).exitCode;`;
      const wrapper = spawn(
        process.execPath,
        ["--input-type=module", "-e", code],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise<number | null>((resolve) =>
        wrapper.once("exit", resolve),
      );
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("child did not start")),
            5000,
          );
          wrapper.stdout.once("data", (chunk: Buffer) => {
            clearTimeout(deadline);
            resolve(chunk.toString());
          });
        });
        const pid = Number(/READY (\d+)/.exec(output)?.[1]);
        wrapper.kill("SIGTERM");
        expect(await closed).toBe(143);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        wrapper.kill("SIGKILL");
      }
    });

    it("removes signal handlers after repeated calls and launch errors", async () => {
      const before = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      for (let n = 0; n < 3; n++)
        expect(
          (
            await superviseChild(process.execPath, ["-e", "process.exit(7)"], {
              capture: true,
            })
          ).exitCode,
        ).toBe(7);
      await expect(superviseChild("/does-not-exist", [])).rejects.toThrow();
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ]).toEqual(before);
    });
  },
);
