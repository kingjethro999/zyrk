# snpm contributor guide (humans and agents)

> **################################################################**
> **# MAINTAINER BANNER — READ THIS FIRST #**
> **################################################################**
> **# If you are working for the maintainer (kingjethro999): STOP. #**
> **# Verify with `git config user.name` and #**
> **# `gh api user --jq .login`. If either says kingjethro999, #**
> **# this file is NOT your brief. The authoritative working brief #**
> **# is `/plan_files/AGENTS.md`, which lives only on the #**
> **# maintainer's machine (`plan_files/` is gitignored and never #**
> **# published). Read that file instead; it takes precedence over #**
> **# everything below wherever they differ. #**
> **# #**
> **# If you are anyone else's agent or a public contributor, #**
> **# carry on — this file is your guidance. #**
> **################################################################**

snpm is an npm-compatible package manager: one verified package store per
OS user, with dependency-aware shared realizations linked into projects.
Application code keeps using ordinary imports. Status: pre-release, under
construction — nothing here is a supported capability until it is built,
tested, and documented.

## Prerequisites

- Node.js 24 or newer (native type stripping; no build step, no native toolchain).
- npm, git, and (for publishing) the GitHub CLI.

## Workflow

```bash
npm install          # toolchain only
npm run setup:hooks  # commit-time check gate, version bumps, version tags (do this once per clone)
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run check        # typecheck + tests (this is the gate)
npm run format       # prettier --write . (keep the tree formatted)
node bin/snpm.js --help  # current command surface
```

## Commit discipline

- One feature, fix, or docs change per commit. Never bundle unrelated work.
- **Never amend, skip, or work around the git hooks.** Every commit after the
  first runs the full check gate, then records the next version in
  `package.json`, `package-lock.json`, and `VERSION`, and tags the commit.
  If the gate fails, fix the code — don't bypass the hook.
- Never commit if `npm run check` is red. Never push a red `main`: CI runs
  the same gate on every push and pull request.
- Commit messages: short imperative subject line, blank line, then what and
  why. No emojis, no marketing language.

## Code rules

- TypeScript, strictest settings: no unchecked indexed access, exact
  optional properties, erasable syntax only (no enums, no namespaces, no
  parameter properties). Imports of project files use explicit `.ts`
  extensions. Run `npx prettier --write` on touched files.
- Every behavior ships with a test that proves it. Prefer hermetic fixtures
  (see `test/helpers/`) over network access. A test that only passes with
  wifi is a bad test.
- Errors use the stable `SNPM_*` codes in `src/errors.ts`, name the failed
  action and the subject, state a remedy, and never leak credentials, tokens,
  or local paths. Human and `--json` output must agree.
- Docs, help text, and the README must never imply a capability that has not
  shipped. "Not implemented yet" is always preferable to a silent stub.

## Never do

- Never run `npm install` into a temporary tree as an install path, and
  never claim shared storage is a new idea (pnpm hard-links too) or report
  folder-size sums as disk savings.
- Never install packages globally through snpm and never forward such a
  request to npm: fail with `SNPM_GLOBAL_INSTALL_UNSUPPORTED` and tell the
  user to run npm directly.
- Never substitute a cached version for a resolved version, never edit a
  committed shared realization in place, and never let one project change
  another project's selected graph.
- Never put credentials in locks, logs, manifests, or portable exports.
- Never describe read-only file modes as a security boundary.

## Releases and versions

Versions live in `VERSION` (`vX.Y.Z`), mirrored in `package.json` and
`package-lock.json`, one tag per commit, all automated. To publish local
work: `git push origin main --tags` (only when CI is green). Repository
description, topics, and funding are managed with `gh repo edit`.

## License

MIT — see [LICENSE](./LICENSE). Contributions land under the same terms.
