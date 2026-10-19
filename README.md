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

Requires **Node.js 24 or newer**. Published packages contain compiled JavaScript. A checkout runs TypeScript
through Node's native type stripping; the check gate also builds and tests the
source-free package layout. Installing zyrk requires no native toolchain.

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

Dependency install scripts and implicit `binding.gyp` builds require explicit
approval. Review first, trust the selected sources, then install:

```bash
zyrk approve-builds                # inspect exact sources and commands; executes no package code
zyrk approve-builds esbuild        # approve reviewed candidates by package name
zyrk install
zyrk rebuild --offline             # rebuild the complete approved locked graph
```

Approvals are local to the exact graph, sources, patch contents, and script
policy. Mandatory user denies override project approvals. Approved scripts run
with your account's permissions; permission is not a sandbox. Packages that need
writes use a complete private dependency generation under `.zyrk-local/`, with
independent writable files and dependency links confined to that generation.
Build failure keeps the previous project graph active. `--ignore-scripts`
explicitly publishes an **intentionally unbuilt** installation. Root install
hooks never run automatically. A project can request runtime writable packages
with `"zyrk": { "mutablePackages": ["package-name"] }`; this also uses a complete
private graph.

Default registry and authentication settings are loaded from user/project
`.npmrc` for installation, dependency edits, `dlx`, and `create`. Environment
token placeholders are supported. Credentials are restricted to their configured
scheme, host, port, and path; redirects cannot expand that scope. Use
`--registry=https://your-registry.example/` on install for an explicit registry.
Scoped registries route metadata, exact sources, imports and tool commands by
the real package name, including aliases. Advisory requests are partitioned by
registry; private names never fall back to a public endpoint. Disabled TLS
verification is rejected before lookup. Git sources and non-workspace local sources remain unsupported;
they fail explicitly. Optional dependencies incompatible with the selected platform
are omitted; missing packages, integrity failures, and other optional failures
remain errors. Locks retain exact platform-qualified optional variants; each machine
selects its compatible local closure without rewriting the lock or recording store
paths. Older platform-pruned locks need an intentional non-frozen refresh; incomplete
npm locks must be freshly resolved before portable adoption. macOS, Windows, and
broad framework compatibility have not passed their release gates.

### Workspaces

Standard `package.json` workspaces use one root lock and a recoverable transaction
for all importer projections. Workspace packages remain editable live directories;
registry closures independent of live sources can still use shared realizations.
Run install or dependency edits from the root or a member directory. Root settings
and registry policy apply to every member.

```bash
zyrk install
zyrk run --workspace app start       # exact workspace name or relative path
zyrk run --recursive build           # dependency-first member scripts
cd packages/app
zyrk add package-name                # edit this importer, preserve other selections
```

Frozen/offline installs, live peers, patches, mutable registry packages, inspection,
and repair have workspace fixtures. Builds that reach live workspace sources are
blocked before execution. Existing npm v2/v3 workspace `package-lock.json` selections can be adopted with
`zyrk import --from npm`, preserving exact versions, aliases and live members.
Adoption validates the complete graph before project changes; npm shrinkwrap
precedence and unsupported bundled/external links fail explicitly. Workspace-root production exports include live member closures and assets. Recursive execution supports
member scripts; filters are exact names or paths, not arbitrary glob expressions.

### Run a one-off tool

```bash
zyrk dlx <package>[@version] [args...]
zyrk create <initializer>[@version] [args...]
```

When running from source, replace `zyrk` with `node bin/zyrk.js`.

`dlx` resolves the requested package and its dependencies, verifies downloaded
archives, creates a dependency-aware tool graph, and launches the selected
JavaScript, shell, or native executable bin entry with the supplied arguments. Its temporary projection is
removed afterward; verified sources and shared realizations remain in the
store.

`create` maps initializer names to their `create-*` packages. For example,
`vite` maps to `create-vite`, while a scoped initializer stays in its scope.
Initializers run from an independent writable private closure so copied templates
can be edited without modifying verified store files. The temporary closure is
removed afterward; generic `dlx` tools continue to use immutable shared files.

For `create next-app`, the native adapter accepts resolved create-next-app
15.x and 16.x releases, whose official CLI provides `--skip-install`; the real
scaffold check covers 16.4.2. Other versions fail before execution. zyrk passes the official `--skip-install` flag to
create-next-app, validates the generated project manifest, then installs its
dependencies through zyrk using the same store and registry configuration. An
explicit `--skip-install` leaves the generated project uninstalled. The official
flag can select create-next-app's configuration defaults instead of prompting
for each choice; pass its explicit configuration flags to customize them. Its
interactive project-name prompt remains available. Supply an explicit target
for nested or existing empty directories; automatic interactive discovery is
limited to one newly created direct child directory. If generation exits without
a valid manifest, zyrk reports failure and retains any generated files for review.

Other initializers control their own dependency-install step and may invoke
another package manager. Use their skip-install option, when available, then run
`zyrk install` in the generated project to keep installation native to zyrk.
Compatibility depends on the selected tool:
closures declaring install lifecycle scripts, implicit native builds, or bundled
install hooks are blocked. Dependency executables are available on the tool
PATH. Parent cancellation terminates the supervised process group with bounded
escalation on POSIX systems.

These commands run the tool's code with your account's permissions. The tool
working directory is your current directory. A temporary tool projection is
not a sandbox.

### Current command coverage

| Commands                                                                                                                            | Behavior                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `install`, `i`, `add`, `remove`, `update`                                                                                           | Resolve or reuse exact selections; publish verified dependencies transactionally.                                         |
| `import --from npm`                                                                                                                 | Adopt supported npm v2/v3 lock selections without changing versions.                                                      |
| `fetch --frozen-lockfile`                                                                                                           | Prefetch verified locked sources without running scripts or publishing a projection.                                      |
| `run`, `exec`                                                                                                                       | Execute project scripts or installed binaries; `exec` never fetches.                                                      |
| `dlx`, `create`                                                                                                                     | Verify and run temporary tool closures.                                                                                   |
| `list`, `why`, `doctor`                                                                                                             | Inspect selected dependencies, dependency paths, and project health.                                                      |
| `approve-builds`, `rebuild`                                                                                                         | Review and approve exact build candidates; build a new private generation.                                                |
| `audit`                                                                                                                             | Query exact selected versions under the project privacy policy; distinguish unavailable service from no known advisories. |
| `patch`, `patch-commit`                                                                                                             | Create a private editing area and portable source-bound patch; apply on reinstall.                                        |
| `repair`                                                                                                                            | Re-fetch corrupt locked sources and publish a new realization closure without editing existing shared inodes.             |
| `store path/status/verify/gc/pin/unpin`, `projects list/forget`                                                                     | Inspect storage, verify content, and manage explicit retention roots.                                                     |
| `deploy`, `docker init/build/run`                                                                                                   | Export supported production closures or generate and invoke a pinned Docker setup.                                        |
| `publish`, `unpublish`, `access`, `deprecate`, `dist-tag`, `owner`, `token`, `adduser`, `login`, `logout`, `whoami`, `ping`, `pack` | Explicitly delegate to your npm CLI.                                                                                      |

### Patches, recovery, and cleanup

```bash
zyrk patch package-name            # prints a private editing directory
# Edit files in that directory, then:
zyrk patch-commit <editing-directory>
zyrk install                       # refresh the lock and apply the patch privately
zyrk install --offline --frozen-lockfile

zyrk doctor
zyrk store verify --full
zyrk repair                        # preserve locked versions, publish replacement instances
zyrk store gc --dry-run
zyrk store gc
```

Commit `package.json`, `package-lock.json`, and `.zyrk/patches/` artifacts.
Keep `.zyrk-local/` out of version control: it contains approvals, private builds,
logs, and local install state. Patches bind to verified source manifests; changed
patches invalidate frozen selections. Other projects retain their selected
package instances. Repair retains incident evidence and replaces corrupted
object pathnames, so existing hard links are never rewritten in place.

GC uses recorded project roots, pins, leases, a store coordination lock, and a
30-day grace period. Preview collection before removing retention roots. Live
or uncertain owners are retained. A process killed inside the short lock-publication
guard can leave a guard requiring manual recovery after all zyrk processes stop;
zyrk fails closed instead of guessing which process owns it.

### Export an application

Declare runtime files explicitly and select a direct Node entry:

```bash
zyrk deploy --out ./dist-runtime --omit=dev --files dist --entry dist/server.js
node ./dist-runtime/dist/server.js
```

The exporter validates that links stay inside the output and excludes the host
store. Generic export supports shared production graphs and relocatable private
JavaScript outputs, including selected patches and generated files. Workspace-root exports include live production members, peer contexts, cycles
and assets. A restricted Linux x64 ELF64 N-API copy recipe supports dependency-free
addons using `napi_create_int32` and `napi_set_named_property` with matching
Node/ABI/build profiles. Native bytes are copied unchanged after loader validation.
Other native formats/API imports, external libraries, loader paths, host-path-dependent
outputs and arbitrary shell startup adapters remain unsupported. Exports validate active generation/profile metadata and reject
credentials or escaping links. Structural validation does not prove application health. Run an
application smoke test from the exported directory with host-store access removed.

`zyrk docker init` requires a supported Node image pinned by SHA-256, a local CLI
tarball pinned by SHA-512, runtime files, and an entry. It generates reviewable
`Dockerfile`, `.dockerignore`, `zyrk-docker.json`, and `ZYRK_DOCKER.md`. Builds fetch
with an optional BuildKit npmrc secret, then install and export without networking.
`zyrk docker build --tag app:local` and `zyrk docker run --tag app:local` require a
reachable Docker daemon. Generated configuration has fixture coverage. The opt-in
`node scripts/docker-smoke.mjs` gate exercises a pinned image and a network-free
runtime. A Linux daemon run passed cold/warm builds, imports and asset access
without host mounts. Broad framework compatibility still requires application-specific checks.

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
- **Mutable work:** approved builds, patches, and runtime-writable packages use
  independent private project generations. Writable outputs do not alter shared source.

Read-only modes help prevent accidental writes; they are not a security boundary
against code running as the same OS user. Shared stores should be used only by
mutually trusted processes. Do not share them across unrelated CI trust domains.

Archive expansion, metadata sizes, resolution growth, fetch totals, and operation
deadlines are bounded. These limits defend against accidental and hostile
resource exhaustion; they do not make executed dependencies trustworthy.
Security reports belong in the private reporting channel described in
[SECURITY.md](SECURITY.md).

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
GitHub release is published. It verifies the release tag, formatting, typecheck,
build, and tests, then publishes that exact commit. Ordinary commits do not
publish packages. Dependabot and a scheduled advisory check supplement CI; an
unavailable advisory service fails separately from a clean result.

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

Root `package.json` dependency overrides support exact specifications, nested and
version-qualified selectors, self rules (`.`), and `$direct` references. Direct
dependency overrides must match the declared specification. Workspace member
overrides are ignored, matching npm root-only policy. Override rule order is
recorded in the manifest fingerprint; frozen installs reject policy drift.

`zyrk help` and `zyrk --help` both show help successfully. Installs report
preparation, resolution, verified source counts, realization, approved builds,
and project linking on stderr. Interactive terminals show an activity spinner;
redirected output contains plain phase messages. `--json` disables progress.

Install resolution has a five-minute deadline; each archive extraction has a
two-minute deadline. Set `ZYRK_RESOLVE_TIMEOUT_MS` or `ZYRK_EXTRACT_TIMEOUT_MS`
to an integer from `1` to `900000` milliseconds to adjust these timeouts.
Graph, archive-entry, and byte limits still apply.
