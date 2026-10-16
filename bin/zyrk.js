#!/usr/bin/env node
import { runCli } from "../src/cli/main.ts";

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
