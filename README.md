# zyrk

[![CI](https://github.com/kingjethro999/zyrk/actions/workflows/ci.yml/badge.svg)](https://github.com/kingjethro999/zyrk/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An npm-compatible package manager built around **one verified package store per
OS user**, with dependency-aware package instances linked into projects.

**Pre-release and under active construction.** `zyrk install` installs project
dependencies through verified shared storage; `dlx` and `create` run one-off
tools. Check `zyrk --help` and the limitations below before adopting it.

## Why zyrk exists

A developer often works on several Node.js projects with overlapping
dependencies. zyrk's intended default is to verify package sources once, keep
them in a per-user store, and assemble each project's dependency graph through
links. Different versions and peer dependency contexts remain separate.

Application code keeps using ordinary imports. There is no custom Node.js
loader, privileged daemon, or manual mount setup in the intended development
model.

Sharing files is an established approach: pnpm also uses hard links. zyrk makes
the shared store, exact dependency context, mutation rules, and cleanup contract
central to its design. Storage savings, speed, and framework compatibility will
be reported only after reproducible measurements and compatibility tests.

## Try the current CLI

Install from npm:

```bash
npm install -g zyrk
zyrk --help
zyrk --version
```

Requires **Node.js 24 or newer**. The source runs directly with Node's native
TypeScript support; no compilation step or native toolchain is required to
install zyrk itself.

From a checkout:

```bash
git clone https://github.com/kingjethro999/zyrk.git zyrk
cd zyrk
npm ci
node bin/zyrk.js --help
node bin/zyrk.js --version
```

### One-line install (shell)

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.ps1 | iex
```

### Install project dependencies

```bash
zyrk install                     # dependencies + devDependencies
zyrk install react               # add and save a registry package
zyrk install -D typescript        # save a development dependency
zyrk i --frozen-lockfile          # require an unchanged compatible lock
zyrk install --offline --frozen-lockfile
zyrk install --omit=dev           # project production roots only
zyrk install --lockfile-only      # write selections without installing
```

zyrk resolves exact versions, verifies archive integrity before extraction, and
creates dependency-aware realizations in the per-user store. Project
`node_modules` contains links to those realizations. Two projects selecting the
same dependency context reuse the same files; incompatible versions and peer
contexts stay separate. Normal CJS and ESM imports continue to work.

`package-lock.json` records npm selections plus a `zyrk` extension. Warm installs
reuse compatible locked selections; frozen installs reject drift. Non-frozen
installation can adopt supported npm v2/v3 lockfiles without reselecting versions.
Offline installs use locked verified sources and fail if an input is missing.
Manifest, lock, and projection changes are journaled for process-crash recovery;
a failed resolution, verification, or build-policy check keeps the prior graph.

Dependency install scripts and implicit native builds are blocked by default.
`--ignore-scripts` explicitly produces an **intentionally unbuilt** installation.
Root install hooks are reported and never run automatically. Script approval,
private native builds, runtime-mutable packages, workspaces, overrides, Git/local
sources, and authenticated or mixed scoped registries are not supported by this
install path yet. Unsupported platform constraints and failed optional packages
currently fail installation instead of being silently omitted. macOS/Windows
compatibility and framework support remain unverified.

Use `--registry=https://your-registry.example/` for a compatible unauthenticated
registry. The adapter reads the default registry from user/project `.npmrc`, and
fails closed on scoped registry routing or disabled TLS verification. Tool
commands (`dlx`/`create`) still use their existing public-registry configuration.

### Run a one-off tool

```bash
zyrk dlx <package>[@version] [args...]
zyrk create <initializer>[@version] [args...]
```

When running from source, replace `zyrk` with `node bin/zyrk.js`.

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

| Surface                                                                                | Current behavior                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `install`, `i`                                                                         | Resolve or reuse the lock, verify sources, and publish shared project dependencies. |
| `--help`, `--version`                                                                  | Show the CLI surface and package version.                                           |
| `dlx`, `create`                                                                        | Resolve, fetch, verify archives, and run temporary tool environments.               |
| `publish`, `unpublish`, `access`, `deprecate`, `dist-tag`, `owner`                     | Explicitly delegate to your npm CLI.                                                |
| `token`, `adduser`, `login`, `logout`, `whoami`, `ping`, `pack`                        | Explicitly delegate to your npm CLI.                                                |
| `add`, `remove`, `update`, `run`, `exec`                                               | Report `ZYRK_NOT_IMPLEMENTED`.                                                      |
| `store`, `projects`, `repair`, `import`, `deploy`, `docker`                            | Report `ZYRK_NOT_IMPLEMENTED`.                                                      |
| `list`, `why`, `doctor`, `approve-builds`, `rebuild`, `audit`, `patch`, `patch-commit` | Report `ZYRK_NOT_IMPLEMENTED`.                                                      |

Native commands that support `--json` return a versioned result envelope.
`dlx` and `create` reject that option because the tool owns stdout. Delegated
commands preserve npm's own output format.

## Storage, isolation, and trust

On Linux, the default store is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/zyrk/store/v1
```

Set `ZYRK_STORE_DIR` deliberately to choose another store location. The store
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

zyrk never installs packages globally and never forwards a global-install
request to npm:

```bash
zyrk install --global <package>
# ZYRK_GLOBAL_INSTALL_UNSUPPORTED
```

Use npm directly when you want a global package. Installing the zyrk executable
with npm is separate from asking zyrk to install another package globally.

Registry write and account operations use your npm installation. zyrk prints a
disclosure, inherits stdio, and returns the child status. npm uses its own
registry configuration and authentication:

```bash
zyrk publish --tag beta
zyrk pack --ignore-scripts
```

npm options may come before or after the command: zyrk forwards every
non-zyrk token verbatim, so protective flags such as `--dry-run` always
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

CI checks pushed commits and pull requests. The separate
[npm publishing action](.github/workflows/npm-publish.yml) is triggered when a
GitHub release is created; ordinary commits do not trigger that action.

The contributor guide is [AGENTS.md](AGENTS.md). Bug reports and reproducible
compatibility cases belong in
[GitHub issues](https://github.com/kingjethro999/zyrk/issues).

## Naming and local state

The project was renamed from snpm to **zyrk**. The shared-store philosophy,
version isolation, mutation policy, and security requirements remain the same.
Current CLI/configuration uses `zyrk` / `ZYRK`, and lock metadata uses the `zyrk`
namespace. Pre-rename stores and lock metadata are not migrated automatically.
Keep existing data until an explicit migration is supported.

## License

[MIT](LICENSE). If you want to support development,
[sponsor the maintainer](https://github.com/sponsors/kingjethro999).
