# Upstream SnPM review for Zyrk

Reviewed 2026-10-22 against `binbandit/snpm` revision
`00c5705d9b888b11ca21875d3ca45e0588731877` (`main`). The earlier
`/tmp/opencode/snpm` checkout was no longer present, so this review uses the
current public repository.

## What the project contains

SnPM is a substantial Rust package manager, not just a fast filesystem helper.
Its workspace separates a Rust CLI, core resolver/store/installer, npm-style
semver, and a Node-version launcher. It uses Tokio and futures for async work,
Rayon for parallel CPU work, Reqwest for registry traffic, and a release build
profile with fat LTO and one codegen unit. Its core also depends on reflink
copy support. The npm distribution installs native platform binaries.

Its README describes a pnpm-shaped project virtual store under
`node_modules/.snpm`, workspace-aware installs, its own YAML lock, lockfile
imports, script allowlists, and broad package-manager commands. This differs
from Zyrk's per-user verified source store, dependency-context realizations,
and npm `package-lock.json` contract. Those models should not be blended
without a deliberate architecture change.

## Useful ideas for Zyrk

1. **Benchmark before selecting a faster implementation language.** SnPM has
   a Hyperfine harness for cold, warm, and no-op installs, with separate
   project directories and package-manager caches. Zyrk's contract calls for
   additional cases: second checkout reuse, overlapping unrelated projects,
   peer-context changes, offline frozen installs, GC, deploy, and Docker.
   Add these before making speed or savings claims.
2. **Profile the expensive phases independently.** Zyrk already uses bounded
   fetch concurrency (`src/fetch/all.ts`) and streaming, two-pass safe archive
   extraction (`src/extract/tarball.ts`). Reuse verification and realization
   include repeated file and graph work (`src/store/verify.ts`,
   `src/store/realize.ts`, `src/store/objects.ts`). Measure resolution,
   downloading, decompression, digest verification, realization, projection,
   and process startup separately. A Rust rewrite is justified only if a
   repeatable profile identifies CPU or Node runtime overhead as a material
   bottleneck.
3. **Consider bounded parallelism for independent work.** SnPM uses both
   asynchronous I/O and Rayon. Zyrk can evaluate bounded parallel hashing or
   independent realization work after benchmarks show a bottleneck. Keep
   memory and open-file use bounded, results deterministic, dependencies
   ordered where required, cancellation joined before cleanup, and shared
   objects immutable. Its existing fetch pool is a good pattern to extend,
   not replace with unbounded `Promise.all`.
4. **Buffer archive input.** SnPM wraps archive input in a 64 KiB
   `BufReader` before decompression. Zyrk already streams a file through
   gunzip and the tar parser; benchmark read sizes and syscall cost before
   changing its extraction path. Do not remove Zyrk's validation pass,
   expanded-size limits, path checks, or exclusive staging writes for speed.
5. **Treat reflinks as an optional measured backend.** SnPM uses a
   clone-or-copy helper and `reflink-copy`. Zyrk's hard-linked immutable
   objects and context-specific realization layout have different mutation
   guarantees. Reflinks may be relevant to private materialization or deploy
   on supported filesystems, with a clearly reported copy fallback; they are
   not a drop-in replacement for the existing store layout.
6. **Borrow release/compatibility engineering.** Native binaries require
   platform packaging, installation selection, and a compatibility matrix.
   SnPM also maintains a real-repository compatibility lab. Zyrk can borrow
   the repeatable-fixture and platform-matrix approach without adopting a
   native runtime.

## Benchmark caveats

The upstream `benchmarks/bench.sh` is a useful starting point, but it should
not be copied as evidence of a fair head-to-head result. Its fixture uses
semver ranges and lets each manager produce its own lockfile, so selected
transitive graphs may differ. Its checked-in scenarios focus on cold, warm,
and hot installs, while Zyrk must also measure reuse, integrity verification,
resource use, and correctness. Any Zyrk comparison should record exact tool
versions, OS/filesystem, hardware, lock and script policy, cold/warm cache
state, repeated-run variance, network bytes, CPU, peak memory, and source
payload allocation. Compare default pnpm and its global-store mode separately.

## Recommendation

Do not start a Rust rewrite yet. First add a hermetic benchmark fixture and
repeatable real-project scenarios, collect CPU/heap profiles, and identify a
measurable hot path. Then prototype one isolated optimization behind the
existing TypeScript interfaces and rerun correctness, compatibility, and
performance gates. The project brief permits a Rust filesystem helper only
when profiling demonstrates a need; a native CLI would also add multi-platform
build, npm packaging, and support costs.

No upstream source code was copied in this review. If a later implementation
does copy code, check the repository's `MIT OR Apache-2.0` terms and retain the
required license and attribution notices.

## Sources

- [Upstream repository and current README](https://github.com/binbandit/snpm)
- [Upstream benchmark harness](https://github.com/binbandit/snpm/blob/main/benchmarks/bench.sh)
- [Upstream Rust workspace manifest](https://github.com/binbandit/snpm/blob/main/Cargo.toml)
- Zyrk's detailed performance requirements are in the maintainer-only
  `plan_files/AGENTS.md` brief and are not included in the published repository.
