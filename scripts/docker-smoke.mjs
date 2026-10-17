#!/usr/bin/env node
/** Opt-in real Docker gate. No credentials, user stores, or existing images are removed. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const pinnedImage =
  "node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const buildxUrl =
  "https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64";
const buildxSha =
  "4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287";

async function main() {
  let image = pinnedImage,
    bootstrap = false,
    buildxBinary;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--help") {
      console.log(
        "Opt-in Docker smoke: node scripts/docker-smoke.mjs [--bootstrap-buildx | --buildx-binary=<path>] [--node-image=node:24-variant@sha256:<digest>]\nUses network for the pinned image, public npm fixtures, and optionally checksum-pinned temporary Buildx. A provided Buildx binary must match the pinned Linux x64 release checksum. Runs the final container without networking. Requires a reachable local Docker daemon. Cleans only its unique container/image and temporary files; Docker's ordinary shared build cache/base-image cache is retained.",
      );
      return 0;
    }
    if (arg === "--bootstrap-buildx") bootstrap = true;
    else if (arg.startsWith("--buildx-binary="))
      buildxBinary = path.resolve(arg.slice("--buildx-binary=".length));
    else if (arg.startsWith("--node-image="))
      image = arg.slice("--node-image=".length);
    else throw new Error("Unknown smoke option; use --help.");
  }
  if (!/^node:24[a-zA-Z0-9._-]*@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error("Docker smoke requires a SHA256-pinned Node 24 image.");
  if (process.platform !== "linux")
    throw new Error("This smoke gate currently exercises Linux Docker only.");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "zyrk-docker-smoke-"));
  const tag = `zyrk-smoke:${randomUUID()}`;
  const container = `zyrk-smoke-${randomUUID()}`;
  const project = path.join(scratch, "project"),
    store = path.join(scratch, "store");
  const dockerConfig = path.join(scratch, "docker-config");
  await Promise.all([
    mkdir(project),
    mkdir(dockerConfig),
    mkdir(path.join(scratch, "config")),
  ]);
  const userconfig = path.join(scratch, "user.npmrc"),
    globalconfig = path.join(scratch, "global.npmrc");
  await Promise.all([
    writeFile(userconfig, "registry=https://registry.npmjs.org/\n"),
    writeFile(globalconfig, ""),
  ]);
  // Deliberately pass an allowlist; inherited registry tokens, npm configuration,
  // Docker credentials, and zyrk policy/store overrides never enter the fixture.
  const env = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    LANG: "C.UTF-8",
    TMPDIR: scratch,
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_cache: path.join(scratch, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    DOCKER_CONFIG: dockerConfig,
    DOCKER_BUILDKIT: "1",
    ZYRK_STORE_DIR: store,
  };
  const cli = path.join(repository, "bin/zyrk.js");
  async function run(command, args, options = {}) {
    const {
      cwd = project,
      timeout = 120_000,
      quiet = false,
      allowFailure = false,
    } = options;
    if (!quiet)
      console.log(
        `docker-smoke: ${command === process.execPath ? "node" : command} ${args.join(" ")}`,
      );
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        timedOut = false,
        escalation;
      const kill = (signal) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          /* Already stopped. */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 3000);
      }, timeout);
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk.toString()).slice(-8 * 1024 * 1024);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8 * 1024 * 1024);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        if (!allowFailure && (status !== 0 || timedOut || signal))
          reject(
            new Error(
              `${command} failed (${timedOut ? "deadline exceeded" : (status ?? signal)}):\n${stderr.slice(-12000)}\n${stdout.slice(-4000)}`,
            ),
          );
        else resolve({ status, stdout, stderr });
      });
    });
  }
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    const buildx = await run("docker", ["buildx", "version"], {
      allowFailure: true,
      quiet: true,
    });
    if (buildx.status !== 0) {
      if ((!bootstrap && !buildxBinary) || process.arch !== "x64")
        throw new Error(
          "Docker Buildx is unavailable. Install it or explicitly opt into --bootstrap-buildx on Linux x64.",
        );
      let bytes;
      if (buildxBinary) bytes = await readFile(buildxBinary);
      else {
        console.log(
          "docker-smoke: fetching checksum-pinned temporary Docker Buildx v0.38.0",
        );
        const response = await fetch(buildxUrl, {
          // The pinned release is about 65 MiB; allow ordinary slower links.
          signal: AbortSignal.timeout(10 * 60_000),
        });
        if (!response.ok)
          throw new Error(
            `Buildx download failed with HTTP ${response.status}.`,
          );
        bytes = Buffer.from(await response.arrayBuffer());
      }
      if (
        bytes.length > 100 * 1024 * 1024 ||
        createHash("sha256").update(bytes).digest("hex") !== buildxSha
      )
        throw new Error("Temporary Buildx binary failed SHA256 verification.");
      const plugins = path.join(dockerConfig, "cli-plugins");
      await mkdir(plugins);
      const plugin = path.join(plugins, "docker-buildx");
      await writeFile(plugin, bytes, { mode: 0o700 });
      await chmod(plugin, 0o700);
      await run("docker", ["buildx", "version"]);
    }
    await run("npm", ["run", "build"], { cwd: repository });
    const packed = await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: repository },
    );
    // npm 12 keys JSON records by package name; older npm returns an array.
    const records = JSON.parse(packed.stdout);
    const filename = (
      Array.isArray(records) ? records : Object.values(records)
    ).at(0)?.filename;
    if (typeof filename !== "string" || path.basename(filename) !== filename)
      throw new Error("npm pack returned an invalid filename.");
    const artifact = path.join(scratch, filename),
      artifactName = "zyrk-cli.tgz";
    const sha512 = createHash("sha512")
      .update(await readFile(artifact))
      .digest("hex");
    await copyFile(artifact, path.join(project, artifactName));
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify(
        {
          name: "zyrk-docker-smoke",
          version: "1.0.0",
          private: true,
          dependencies: { "is-number": "7.0.0" },
        },
        null,
        2,
      ) + "\n",
    );
    await mkdir(path.join(project, "assets"));
    await writeFile(
      path.join(project, "assets", "message.txt"),
      "portable-asset\n",
    );
    await writeFile(
      path.join(project, "app.cjs"),
      "const fs=require('node:fs');const number=require('is-number');console.log('ZYRK_DOCKER_SMOKE '+JSON.stringify({number:number(42),asset:fs.readFileSync('assets/message.txt','utf8').trim()}));\n",
    );
    await writeFile(
      path.join(project, ".env"),
      "DOCKER_SMOKE_FAKE_SECRET=fixture-only\n",
    );
    await writeFile(
      path.join(project, ".npmrc"),
      "//smoke.invalid/:_authToken=DOCKER_SMOKE_FAKE_AUTH\n",
    );
    await writeFile(
      path.join(project, "fixture.pem"),
      "DOCKER_SMOKE_FAKE_CERTIFICATE\n",
    );
    await run(process.execPath, [cli, "install"]);
    await run(process.execPath, [cli, "fetch", "--frozen-lockfile"]);
    await run(process.execPath, [
      cli,
      "install",
      "--frozen-lockfile",
      "--offline",
    ]);
    await run(process.execPath, [
      cli,
      "docker",
      "init",
      "--node-image",
      image,
      "--cli-artifact",
      artifactName,
      "--cli-sha512",
      sha512,
      "--files",
      "app.cjs",
      "--files",
      "assets",
      "--entry",
      "app.cjs",
    ]);
    await run(process.execPath, [cli, "docker", "build", "--tag", tag], {
      timeout: 12 * 60_000,
    });
    console.log("docker-smoke: repeating generated build with warm cache");
    await run(process.execPath, [cli, "docker", "build", "--tag", tag], {
      timeout: 12 * 60_000,
    });
    await run("docker", ["create", "--name", container, "--network=none", tag]);
    const config = JSON.parse(
      (await run("docker", ["inspect", container], { quiet: true })).stdout,
    )[0];
    if (
      config.HostConfig.NetworkMode !== "none" ||
      config.Mounts.length !== 0 ||
      config.Config.User !== "node"
    )
      throw new Error(
        "Runtime container has unexpected networking, mounts, or user.",
      );
    if (
      config.Config.Env.some((value) =>
        /^(?:ZYRK_STORE_DIR|NODE_AUTH_TOKEN|NPM_TOKEN|npm_config_userconfig)=/i.test(
          value,
        ),
      )
    )
      throw new Error(
        "Runtime container retained build credential/store environment.",
      );
    const output = (await run("docker", ["start", "--attach", container]))
      .stdout;
    if (
      !output.includes(
        'ZYRK_DOCKER_SMOKE {"number":true,"asset":"portable-asset"}',
      )
    )
      throw new Error("Runtime import/asset smoke failed.");
    const inspector = `const fs=require('node:fs'),p=require('node:path');for(const f of ['/zyrk-store','/root/.npmrc','/app/.npmrc','/app/.zyrk-local'])if(fs.existsSync(f))throw Error('forbidden runtime path');function walk(d){for(const n of fs.readdirSync(d)){if(/^(?:\\.npmrc|\\.netrc|\\.env(?:$|\\.)|.*\\.(?:pem|key))$/.test(n))throw Error('credential file');const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink()){const target=fs.realpathSync(f);if(target!=='/app'&&!target.startsWith('/app/'))throw Error('escaping runtime link');}else if(s.isDirectory())walk(f);else if(s.isFile()&&s.size<1048576&&fs.readFileSync(f).includes(Buffer.from('DOCKER_SMOKE_FAKE_')))throw Error('fixture credential material');}}walk('/app');const resolved=fs.realpathSync(require.resolve('is-number'));if(!resolved.startsWith('/app/'))throw Error('host store resolution');console.log('ZYRK_DOCKER_BOUNDARIES_OK');`;
    const inspection = await run("docker", [
      "run",
      "--rm",
      "--network=none",
      "--user",
      "root",
      "--entrypoint",
      "node",
      tag,
      "-e",
      inspector,
    ]);
    if (!inspection.stdout.includes("ZYRK_DOCKER_BOUNDARIES_OK"))
      throw new Error("Runtime boundary inspection failed.");
    console.log(
      JSON.stringify({
        gate: "docker-smoke",
        status: "passed",
        nodeImage: image,
        cliSha512: sha512,
        dependency: "is-number@7.0.0",
        network: "none",
        hostMounts: 0,
        buildPasses: 2,
      }),
    );
    return 0;
  } finally {
    await run("docker", ["rm", "--force", container], {
      allowFailure: true,
      quiet: true,
      timeout: 30_000,
    }).catch(() => {});
    await run("docker", ["image", "rm", "--force", tag], {
      allowFailure: true,
      quiet: true,
      timeout: 30_000,
    }).catch(() => {});
    // Make only this fixture's immutable store directories removable.
    const { rmrfNoFollow } = await import("../src/util/fsx.ts");
    await rmrfNoFollow(scratch);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`docker-smoke: ${error.message}`);
    process.exitCode = 1;
  },
);
