#!/usr/bin/env node
import { existsSync } from "node:fs";

// Checkouts run the current source. Published packages contain emitted JS only.
const source = new URL("../src/cli/main.ts", import.meta.url);
const { runCli } = await import(
  existsSync(source)
    ? source.href
    : new URL("../dist/cli/main.js", import.meta.url).href
);

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
