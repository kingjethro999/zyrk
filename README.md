# nexu

[![CI](https://github.com/kingjethro999/nexu/actions/workflows/ci.yml/badge.svg)](https://github.com/kingjethro999/nexu/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An npm-compatible package manager built around **one verified package store per
OS user**, with dependency-aware package instances linked into projects.

**Pre-release and under active construction.** The current CLI can fetch and run
one-off tools with `dlx` and `create`. Ordinary project installation, dependency
editing, garbage collection, repair, and deployment are still being built. Check
`nexu --help` for the implemented command surface.

## Why nexu exists

A developer often works on several Node.js projects with overlapping
dependencies. nexu's intended default is to verify package sources once, keep
them in a per-user store, and assemble each project's dependency graph through
links. Different versions and peer dependency contexts remain separate.

Application code keeps using ordinary imports. There is no custom Node.js
loader, privileged daemon, or manual mount setup in the intended development
model.

Sharing files is an established approach: pnpm also uses hard links. nexu makes
the shared store, exact dependency context, mutation rules, and cleanup contract
central to its design. Storage savings, speed, and framework compatibility will
be reported only after reproducible measurements and compatibility tests.

## Try the current CLI

Requires **Node.js 24 or newer**. The source runs directly with Node's native
TypeScript support; no compilation step or native toolchain is required to
install nexu itself.

From a checkout:

```bash
git clone https://github.com/kingjethro999/nexu.git
cd nexu
npm ci
node bin/nexu.js --help
node bin/nexu.js --version
```

For an npm-distributed build, use the exact package name listed on its npm page
and check that its repository points to `kingjethro999/nexu`. The executable is
`nexu`. Publishing and trusted-publisher setup are described in
[the release guide](docs/releases.md).

### Run a one-off tool

```bash
nexu dlx <package>[@version] [args...]
nexu create <initializer>[@version] [args...]
```

When running from source, replace `nexu` with `node bin/nexu.js`.

`dlx` resolves the requested package and its dependencies, verifies downloaded
archives, creates a dependency-aware tool graph, and launches the selected
JavaScript bin entry with the supplied arguments. Its temporary projection is
removed afterward; verified sources and shared realizations remain in the
store.

`create` uses the same execution path and maps initializer names to their
`create-*` packages. For example, `vite` maps to `create-vite`, while a scoped
initializer stays in its scope. Compatibility depends on the selected tool:
closures declaring install lifecycle scripts are currently blocked, and native
or shell executable bins are not supported by the JavaScript-only launcher.

These commands run the tool's code with your account's permissions. The tool
working directory is your current directory. A temporary tool projection is
not a sandbox.

### Current command coverage

| Surface                                                                                | Current behavior                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `--help`, `--version`                                                                  | Show the CLI surface and package version.                             |
| `dlx`, `create`                                                                        | Resolve, fetch, verify archives, and run temporary tool environments. |
| `publish`, `unpublish`, `access`, `deprecate`, `dist-tag`, `owner`                     | Explicitly delegate to your npm CLI.                                  |
| `token`, `adduser`, `login`, `logout`, `whoami`, `ping`, `pack`                        | Explicitly delegate to your npm CLI.                                  |
| `install`, `add`, `remove`, `update`, `run`, `exec`                                    | Report `NEXU_NOT_IMPLEMENTED`.                                        |
| `store`, `projects`, `repair`, `import`, `deploy`, `docker`                            | Report `NEXU_NOT_IMPLEMENTED`.                                        |
| `list`, `why`, `doctor`, `approve-builds`, `rebuild`, `audit`, `patch`, `patch-commit` | Report `NEXU_NOT_IMPLEMENTED`.                                        |

Native commands that support `--json` return a versioned result envelope.
`dlx` and `create` reject that option because the tool owns stdout. Delegated
commands preserve npm's own output format.

## Storage, isolation, and trust

On Linux, the default store is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/nexu/store/v1
```

Set `NEXU_STORE_DIR` deliberately to choose another store location. The store
must satisfy ownership and permission checks. Linux local filesystems are the
initial target; platform and framework support remain gated on their own tests.

The design separates three things:

- **Verified source:** archive integrity is checked before extraction and source
  publication. Extraction rejects unsafe paths and links and normalizes modes.
- **Dependency context:** a package instance records its selected dependency
  wiring, so incompatible versions and peer contexts are not merged.
- **Mutable work:** the planned build/runtime mutation model uses private
  project generations. Writable build outputs must not change shared source.

Read-only modes help prevent accidental writes; they are not a security boundary
against code running as the same OS user. Shared stores should be used only by
mutually trusted processes. Do not share them across unrelated CI trust domains.

Native tool commands currently use the public npm registry. Private registry
configuration and credential support are not implemented; do not use these
commands for internal tools that depend on private registry routing.

## Global installs and npm delegation

nexu never installs packages globally and never forwards a global-install
request to npm:

```bash
nexu install --global <package>
# NEXU_GLOBAL_INSTALL_UNSUPPORTED
```

Use npm directly when you want a global package. Installing the nexu executable
with npm is separate from asking nexu to install another package globally.

Registry write and account operations use your npm installation. nexu prints a
disclosure, inherits stdio, and returns the child status. npm uses its own
registry configuration and authentication:

```bash
nexu publish --tag beta
nexu pack --ignore-scripts
```

npm options may come before or after the command: nexu forwards every
non-nexu token verbatim, so protective flags such as `--dry-run` always
reach npm. A bare value before the command that cannot be the command
itself fails before npm launches — use the `--flag=value` form or place
the command first. npm may run package lifecycle scripts according to its
own options and configuration.

## Develop and contribute

```bash
npm ci
npm run setup:hooks
npm run typecheck
npm test
npm run check
npm run format:check
npm run format
```

The commit hook runs the full check gate, increments the version in
`package.json`, `package-lock.json`, and `VERSION`, and creates a matching version
tag after the commit. Keep changes focused and never bypass the hooks.

CI checks pushed commits and pull requests. Automated publishing uses the same
checks, version consistency, and a package-content check; see
[releases and npm trusted publishing](docs/releases.md).

The contributor guide is [AGENTS.md](AGENTS.md). Bug reports and reproducible
compatibility cases belong in
[GitHub issues](https://github.com/kingjethro999/nexu/issues).

## Naming and local state

The project was renamed from snpm to **nexu**. The shared-store philosophy,
version isolation, mutation policy, and security requirements remain the same.
Current CLI/configuration uses `nexu` / `NEXU`, and lock metadata uses the `nexu`
namespace. Pre-rename stores and lock metadata are not migrated automatically.
Keep existing data until an explicit migration is supported.

## License

[MIT](LICENSE). If you want to support development,
[sponsor the maintainer](https://github.com/sponsors/kingjethro999).
