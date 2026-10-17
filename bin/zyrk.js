#!/usr/bin/env node
import { runCli } from "../dist/cli/main.js";

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
