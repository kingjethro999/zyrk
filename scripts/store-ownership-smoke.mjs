#!/usr/bin/env node
/** Opt-in Linux acceptance with real distinct UIDs inside one temporary container. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const image =
  "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const name = `zyrk-ownership-smoke-${randomUUID()}`;
const config = await mkdtemp(path.join(os.tmpdir(), "zyrk-ownership-smoke-"));
const env = { PATH: process.env.PATH, DOCKER_CONFIG: config };
// Root only prepares two homes and launches children. All Store.open calls run
// with real, distinct unprivileged kernel UIDs, never a mocked getuid value.
const code = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const users=[{uid:11001,home:'/tmp/user-a'},{uid:11002,home:'/tmp/user-b'}];
for(const user of users){await fs.mkdir(user.home,{mode:0o755});await fs.chown(user.home,user.uid,user.uid);}
function run(user,source,extra={}){
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{
    uid:user.uid,gid:user.uid,encoding:'utf8',timeout:30000,
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:user.home,...extra}
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  return JSON.parse(result.stdout);
}
const create="import {Store} from '/repo/src/store/layout.ts';import fs from 'node:fs/promises';const s=await Store.open({create:true});const st=await fs.stat(s.root);console.log(JSON.stringify({root:s.root,uid:process.getuid(),owner:st.uid,mode:st.mode&511}));";
const stores=users.map(user=>run(user,create));
assert.notEqual(stores[0].root,stores[1].root);
for(let i=0;i<users.length;i++){assert.equal(stores[i].uid,users[i].uid);assert.equal(stores[i].owner,users[i].uid);assert.equal(stores[i].mode,448);}
// Allow traversal so refusal proves the explicit ownership guard, rather than
// simply failing at the kernel's 0700 access check.
const expose="import fs from 'node:fs/promises';import path from 'node:path';import {Store} from '/repo/src/store/layout.ts';const s=await Store.open();for(let p=s.root;p!==process.env.HOME;p=path.dirname(p))await fs.chmod(p,493);console.log('{}');";
run(users[0],expose);
const reject="import assert from 'node:assert/strict';import {Store} from '/repo/src/store/layout.ts';try{await Store.open({create:true});assert.fail('foreign store accepted')}catch(e){assert.equal(e.code,'ZYRK_STORE_UNSAFE');assert.equal(e.detail.ownerUid,11001);assert.equal(e.detail.runningUid,11002)}console.log(JSON.stringify({uid:process.getuid(),code:'ZYRK_STORE_UNSAFE'}));";
const denied=run(users[1],reject,{ZYRK_STORE_DIR:stores[0].root});
assert.equal((await fs.stat(stores[0].root)).uid,11001);
assert.equal((await fs.stat(stores[0].root)).mode&511,493);
console.log(JSON.stringify({gate:'store-ownership-smoke',status:'passed',uids:users.map(u=>u.uid),defaultStoresDistinct:true,foreignStore:denied.code,ownershipUnchanged:true}));
`;
try {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--network=none",
      "--mount",
      `type=bind,source=${repository},target=/repo,readonly`,
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "-e",
      code,
    ],
    { env, encoding: "utf8", timeout: 12 * 60_000, maxBuffer: 1024 * 1024 },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
} catch (error) {
  console.error(`store-ownership-smoke: ${error.message}`);
  process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "--force", name], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  await rm(config, { recursive: true, force: true });
}
