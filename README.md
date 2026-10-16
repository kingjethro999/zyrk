# nexu

**Status: pre-release, under construction.** Nothing in this repository is a
supported capability yet; the CLI surface is being built in the open.

nexu is intended to be an npm-compatible package manager that installs from the
npm registry ecosystem into **one verified package store per OS user**, and
composes each project's `node_modules` from links into dependency-aware
realizations of that store. Application code keeps using ordinary imports.

Nothing here claims storage savings, speed, platform support, or framework
compatibility until the corresponding acceptance scenarios and evidence gates
are met and re-measurable.

## Working on nexu

Requirements: Node.js 24 or newer (the metadata layer uses the built-in
`node:sqlite`; no native compilation toolchain is needed).

```bash
npm install          # toolchain only; nexu itself has no install step yet
npm run setup:hooks  # commit-time check gate and version tags
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run check        # typecheck + tests
```

## Command surface

```bash
node bin/nexu.js --help       # documented commands
node bin/nexu.js --version    # recorded version
node bin/nexu.js <cmd> --json # machine-readable envelope (not for dlx/create)
```

One-off tools run natively, with no global installs involved:

```bash
node bin/nexu.js dlx <package>[@version] [args...]  # resolve, verify, run in a temp env
node bin/nexu.js create <name>[@version] [args...]  # dlx for starters (next-app → create-next-app)
```

Native dependency commands (`install`, `add`, …) are not implemented yet:
nexu reports `NEXU_NOT_IMPLEMENTED` instead of pretending otherwise.

nexu never installs packages globally and never runs npm to do it.
`nexu install -g <pkg>` fails with `NEXU_GLOBAL_INSTALL_UNSUPPORTED` before
any work happens; run npm directly: `npm install --global <pkg>`.

Registry publishing and account commands are delegated to npm, verbatim:
`nexu publish --tag beta` runs `npm publish --tag beta` with your
environment and registry configuration. nexu prints a one-line disclosure,
passes stdio through, and returns npm's exit code or signal unchanged. This
covers `publish`, `unpublish`, `access`, `deprecate`, `dist-tag`, `owner`,
`token`, `adduser`/`login`/`logout`, `whoami`, `ping`, and `pack`. nexu
never implements, wraps, or interferes with publishing or authentication
flows — and global installs are never delegated.

## Naming and local state

The project is now named **nexu**. Its shared-store model, version isolation,
mutation policy, and security requirements remain the same. The CLI is `nexu`,
configuration uses `NEXU_*` environment variables, and lockfile metadata uses
the `nexu` namespace. Pre-rename stores and lock metadata are not migrated
automatically; keep existing data until an explicit migration is supported.

## License

MIT — see [LICENSE](./LICENSE).
