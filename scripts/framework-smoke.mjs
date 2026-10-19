#!/usr/bin/env node
/** Opt-in real registry framework gate. Never runs npm install. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  statfs,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const pins = {
  react: "19.3.1",
  "react-dom": "19.3.1",
  vite: "8.3.4",
  vitest: "5.0.5",
  tailwindcss: "4.3.3",
  "@tailwindcss/vite": "4.3.3",
};
const sources = [
  "https://react.dev/reference/react-dom/server/renderToStaticMarkup",
  "https://vite.dev/guide/",
  "https://vite.dev/guide/static-deploy",
  "https://vitest.dev/guide/",
  "https://tailwindcss.com/docs/installation/using-vite",
];

async function main() {
  let output,
    suppliedStore,
    lockfile = path.join(
      repository,
      "test/fixtures/framework-smoke/package-lock.json",
    ),
    cli = path.join(repository, "bin/zyrk.js");
  for (const arg of process.argv.slice(2)) {
    if (arg === "--help") {
      console.log(
        "Opt-in framework smoke: node scripts/framework-smoke.mjs --output=<new-directory> [--store=<existing-store>] [--cli=<zyrk.js>] [--lockfile=<recorded-package-lock.json>]\nUses the recorded portable fixture lock, public npm registry, exact pinned React/Vite/Vitest/Tailwind packages, and default install resource budgets. Retains the fixture, exact lock, build outputs, and sanitized logs. Uses an isolated configuration home and the default deny script policy; nothing is automatically approved. A recorded lock can be replayed with --lockfile. An existing store makes this a warm verification, never a cold benchmark.",
      );
      return;
    }
    if (arg.startsWith("--output=")) output = path.resolve(arg.slice(9));
    else if (arg.startsWith("--store="))
      suppliedStore = path.resolve(arg.slice(8));
    else if (arg.startsWith("--lockfile="))
      lockfile = path.resolve(arg.slice(11));
    else if (arg.startsWith("--cli=")) cli = path.resolve(arg.slice(6));
    else throw new Error("Unknown framework smoke option; use --help.");
  }
  if (!output) throw new Error("Provide a new --output directory; use --help.");
  await mkdir(output, { mode: 0o700 });
  const project = path.join(output, "project");
  const store = suppliedStore ?? path.join(output, "store");
  const home = path.join(output, "home");
  const tmp = path.join(output, "tmp");
  await Promise.all([mkdir(project), mkdir(home), mkdir(tmp)]);
  const cliRepository = path.dirname(path.dirname(cli));
  const replacements = [
    [project, "<project>"],
    [store, "<store>"],
    [output, "<evidence>"],
    [cliRepository, "<cli-repository>"],
    [repository, "<script-repository>"],
    [process.execPath, "<node>"],
    [os.homedir(), "<home>"],
  ].sort((a, b) => b[0].length - a[0].length);
  function sanitize(value) {
    let text = String(value);
    for (const [from, to] of replacements) text = text.split(from).join(to);
    return text.replace(
      /(?<![:\w])\/(?:home|tmp|var|Users|mnt|opt|usr)\/[^\s"'`]+/g,
      "<local-path>",
    );
  }
  const env = {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(
      path.delimiter,
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    LANG: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    ZYRK_STORE_DIR: store,
  };
  const summary = {
    gate: "framework-smoke",
    registryOrigin: "https://registry.npmjs.org/",
    previewOrigin: "http://127.0.0.1:<ephemeral>",
    status: "running",
    pins,
    sources,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    kernel: os.release(),
    filesystemType: `0x${(await statfs(project)).type.toString(16)}`,
    scriptSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    cliRevision:
      spawnSync("git", ["-C", cliRepository, "rev-parse", "HEAD"], {
        encoding: "utf8",
        env,
      }).stdout?.trim() || "unavailable",
    storeMode: suppliedStore
      ? "existing store; warm verification"
      : "fresh store",
    lifecyclePolicy:
      "default deny; no package lifecycle scripts automatically approved",
    lockInput: "recorded lock; frozen install",
    installBudgets: "defaults; no overrides",
    steps: [],
    limitations: [
      "Pinned fixture on this recorded platform only; no universal compatibility claim.",
      "HTTP preview and React server rendering do not exercise browser hydration or interactions.",
      "HTTP request counts and physical storage savings are not measured.",
    ],
  };
  let preview;
  const persist = () =>
    writeFile(
      path.join(output, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
  async function run(label, command, args, timeout = 120000) {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      expired = false;
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8 * 1024 * 1024);
    });
    const timer = setTimeout(() => {
      expired = true;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    }, timeout);
    let code, signal;
    try {
      [code, signal] = await once(child, "close");
    } finally {
      clearTimeout(timer);
    }
    await writeFile(
      path.join(output, `${label}.log`),
      sanitize(stdout + stderr),
    );
    summary.steps.push({
      label,
      elapsedMs: Math.round(performance.now() - started),
      exitCode: code,
      signal,
      timedOut: expired,
    });
    await persist();
    assert.equal(code, 0, `${label} failed; see sanitized ${label}.log`);
    return stdout;
  }
  try {
    await persist();
    const registryPins = [];
    for (const [name, version] of Object.entries(pins)) {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert.equal(
        response.status,
        200,
        `Pinned registry metadata unavailable: ${name}@${version}`,
      );
      const metadata = await response.json();
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, version);
      registryPins.push({
        name,
        version,
        metadata: url,
        integrity: metadata.dist.integrity,
      });
    }
    await writeFile(
      path.join(output, "registry-pins.json"),
      JSON.stringify(registryPins, null, 2) + "\n",
    );
    const files = {
      "package.json":
        JSON.stringify(
          {
            name: "zyrk-framework-smoke",
            version: "1.0.0",
            private: true,
            type: "module",
            dependencies: { react: pins.react, "react-dom": pins["react-dom"] },
            devDependencies: {
              vite: pins.vite,
              vitest: pins.vitest,
              tailwindcss: pins.tailwindcss,
              "@tailwindcss/vite": pins["@tailwindcss/vite"],
            },
          },
          null,
          2,
        ) + "\n",
      "index.html":
        '<!doctype html><html><head><meta charset="UTF-8"><title>Framework smoke</title></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>\n',
      "app.js":
        'import React from "react";\nexport function App() { const [message] = React.useState("shared-store-smoke"); return React.createElement("h1", { className: "text-3xl font-bold underline" }, message); }\n',
      "main.js":
        'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./app.js";\nimport "./style.css";\ncreateRoot(document.getElementById("root")).render(React.createElement(App));\n',
      "style.css": '@import "tailwindcss";\n',
      "vite.config.js":
        'import { defineConfig } from "vite";\nimport tailwindcss from "@tailwindcss/vite";\nexport default defineConfig({ plugins: [tailwindcss()] });\n',
      "react-render.mjs":
        'import assert from "node:assert/strict";\nimport React from "react";\nimport { renderToStaticMarkup } from "react-dom/server";\nimport { App } from "./app.js";\nassert.equal(React.version, "19.3.1");\nconst html = renderToStaticMarkup(React.createElement(App));\nassert.equal(html, \'<h1 class="text-3xl font-bold underline">shared-store-smoke</h1>\');\nconsole.log(JSON.stringify({react:React.version,html}));\n',
      "app.test.js":
        'import { expect, it } from "vitest";\nimport React from "react";\nimport { renderToStaticMarkup } from "react-dom/server";\nimport { lstat, realpath } from "node:fs/promises";\nimport { App } from "./app.js";\nit("renders hooks with one React instance through shared package links", async () => {\nexpect(React.version).toBe("19.3.1");\nexpect(renderToStaticMarkup(React.createElement(App))).toContain("shared-store-smoke");\nexpect((await lstat("node_modules/react")).isSymbolicLink()).toBe(true);\nexpect(await realpath("node_modules/react")).toContain("realizations");\n});\n',
      "preview.mjs":
        'import { preview } from "vite";\nconst server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });\nconst address = server.httpServer.address();\nconsole.log(JSON.stringify({ port: address.port }));\nasync function close() { await new Promise(resolve => server.httpServer.close(resolve)); process.exit(0); }\nprocess.on("SIGTERM", close); process.on("SIGINT", close);\n',
    };
    await Promise.all(
      Object.entries(files).map(([name, text]) =>
        writeFile(path.join(project, name), text),
      ),
    );
    if (lockfile)
      await writeFile(
        path.join(project, "package-lock.json"),
        await readFile(lockfile),
      );
    const installOutput = await run(
      "install",
      process.execPath,
      [
        cli,
        "install",
        "--frozen-lockfile",
        "--registry=https://registry.npmjs.org/",
        "--json",
      ],
      16 * 60 * 1000,
    );
    const install = JSON.parse(installOutput.trim());
    assert.equal(install.status, "ok");
    summary.install = install;
    summary.lockSha256 = createHash("sha256")
      .update(await readFile(path.join(project, "package-lock.json")))
      .digest("hex");
    for (const name of Object.keys(pins)) {
      assert(
        (
          await lstat(path.join(project, "node_modules", name))
        ).isSymbolicLink(),
        `${name} uses an ordinary package link`,
      );
      assert(
        (await realpath(path.join(project, "node_modules", name))).startsWith(
          await realpath(store),
        ),
        `${name} resolves into the selected store`,
      );
    }
    await run("react-render", process.execPath, ["react-render.mjs"]);
    await run("vitest", path.join(project, "node_modules/.bin/vitest"), [
      "run",
      "app.test.js",
    ]);
    await run("vite-build", path.join(project, "node_modules/.bin/vite"), [
      "build",
    ]);
    const html = await readFile(path.join(project, "dist/index.html"), "utf8");
    const jsPaths = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const cssPaths = [
      ...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g),
    ].map((match) => match[1]);
    assert(
      jsPaths.length > 0 && cssPaths.length > 0,
      "Vite emits JavaScript and CSS assets",
    );
    let previewStdout = "",
      previewStderr = "";
    preview = spawn(process.execPath, ["preview.mjs"], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    preview.stdout.on("data", (chunk) => {
      previewStdout += chunk;
    });
    preview.stderr.on("data", (chunk) => {
      previewStderr += chunk;
    });
    const expires = Date.now() + 30000;
    let port;
    while (Date.now() < expires) {
      const match = previewStdout.match(/\{"port":(\d+)\}/);
      if (match) {
        port = Number(match[1]);
        break;
      }
      if (preview.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await writeFile(
      path.join(output, "preview.log"),
      sanitize(previewStdout + previewStderr),
    );
    assert(port, "Vite preview starts on a loopback ephemeral port");
    const http = [];
    for (const asset of ["/", ...jsPaths, ...cssPaths]) {
      assert(
        asset.startsWith("/") && !asset.startsWith("//"),
        "Asset belongs to local preview",
      );
      const response = await fetch(`http://127.0.0.1:${port}${asset}`, {
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      const contentType = response.headers.get("content-type");
      if (asset === "/") assert(contentType?.includes("text/html"));
      if (asset.endsWith(".js")) assert(contentType?.includes("javascript"));
      if (asset.endsWith(".css")) assert(contentType?.includes("text/css"));
      if (asset.endsWith(".js"))
        assert(
          body.includes("shared-store-smoke"),
          "Built JavaScript contains the application",
        );
      if (asset.endsWith(".css"))
        assert(
          /\.underline\s*\{[^}]*text-decoration-line:\s*underline/.test(body),
          "Tailwind compiles the fixture's underline utility",
        );
      if (asset === "/") assert.equal(body, html);
      http.push({
        asset,
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
    summary.http = http;
    summary.status = "passed";
    await persist();
    console.log(
      JSON.stringify({
        gate: summary.gate,
        status: summary.status,
        readiness: install.readiness,
        packages: install.packages,
        storeMode: summary.storeMode,
        checks: [
          "React hook server render",
          "Vitest shared symlinks",
          "Vite production build",
          "Tailwind compiled utility",
          "preview HTTP HTML/JS/CSS",
        ],
      }),
    );
  } catch (error) {
    summary.status = "failed";
    summary.error = sanitize(error.message);
    await persist();
    throw new Error(summary.error);
  } finally {
    if (preview && preview.exitCode === null) {
      const stopped = once(preview, "exit");
      preview.kill("SIGTERM");
      const timer = setTimeout(() => preview.kill("SIGKILL"), 3000);
      await stopped;
      clearTimeout(timer);
    }
  }
}
main().catch((error) => {
  console.error(
    `framework-smoke: ${error.code ? `setup failed (${error.code}); use a new writable --output directory` : error.message}`,
  );
  process.exitCode = 1;
});
