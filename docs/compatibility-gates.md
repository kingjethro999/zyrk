# Compatibility verification

CI runs the full check gate on Ubuntu and macOS with Node 24. Windows runs emitted CLI/artifact, Unicode/space path, argument parsing, JSON/integrity and explicit store refusal fixtures. A matrix entry is a test target; consult its completed CI run before calling it verified.

Windows shared installation remains unavailable pending an account-isolating ACL adapter. Platform-independent dependency locks do not imply Windows store support. Linux and macOS users create local projections from portable selections; host paths remain local.

Native export currently supports only the documented Linux x64 ELF/N-API recipe. Passing its Linux fixture does not establish macOS or Windows binary relocation. Framework claims likewise require pinned real applications, a native zyrk installation, production builds and runtime checks. Hermetic registry fixtures alone do not establish universal Next.js, Vite, React Native or framework support.

The pinned [React/Vite/Vitest/Tailwind gate](framework-smoke.md) and
[Next.js 16.4.2 Webpack gate](next-compatibility.md) have recorded Linux results.
Next's strict-root Turbopack mode rejects external shared dependencies; use the
documented explicit Webpack commands. Browser interaction and other framework
versions remain outside these checks.
