# snpm

**Status: pre-release, under construction.** Nothing in this repository is a
supported capability yet; the CLI surface is being built in the open.

snpm is intended to be an npm-compatible package manager that installs from the
npm registry ecosystem into **one verified package store per OS user**, and
composes each project's `node_modules` from links into dependency-aware
realizations of that store. Application code keeps using ordinary imports.

Nothing here claims storage savings, speed, platform support, or framework
compatibility until the corresponding acceptance scenarios and evidence gates
are met and re-measurable.

## Working on snpm

Requirements: Node.js 24 or newer (the metadata layer uses the built-in
`node:sqlite`; no native compilation toolchain is needed).

```bash
npm install          # toolchain only; snpm itself has no install step yet
npm run setup:hooks  # commit-time check gate and version tags
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run check        # typecheck + tests
```

## Command surface

```bash
node bin/snpm.js --help       # documented commands
node bin/snpm.js --version    # recorded version
node bin/snpm.js <cmd> --json # machine-readable envelope
```

Native dependency commands (`install`, `add`, …) are not implemented yet:
snpm reports `SNPM_NOT_IMPLEMENTED` instead of pretending otherwise.

snpm never installs packages globally and never runs npm to do it.
`snpm install -g <pkg>` fails with `SNPM_GLOBAL_INSTALL_UNSUPPORTED` before
any work happens; run npm directly: `npm install --global <pkg>`.

## License

MIT — see [LICENSE](./LICENSE).
