# Pinned framework smoke

Run this opt-in gate from a prepared source checkout with Node.js 24 or newer:

```sh
node scripts/framework-smoke.mjs --output=../zyrk-framework-evidence
```

The output directory must be new. The script retains its application, exact
`package-lock.json`, production assets, sanitized command logs, and JSON summary.
It uses the public npm registry and an isolated home/configuration directory;
inherited registry credentials and policy overrides are not passed to children.
Install uses the default resource budgets and default deny script policy, with
no automatic approvals or npm installation subprocess.

By default, the script performs a frozen install of the
[recorded portable lock](../test/fixtures/framework-smoke/package-lock.json).
`--lockfile=<recorded-package-lock.json>` selects another recorded lock matching
the same pinned fixture manifest. `--store=<existing-store>` reuses verified
sources and makes the run a warm verification. `--cli=<zyrk.js>` selects another
source checkout's CLI. Existing stores and evidence directories are retained.

The fixture pins React and React DOM 19.3.1, Vite 8.3.4, Vitest 5.0.5, and
Tailwind CSS plus its Vite plugin 4.3.3. It verifies:

- Ordinary Node imports and a React hook rendered with `renderToStaticMarkup`.
- A Vitest test using the application's actual shared package symlinks.
- A Vite production build using the Tailwind Vite plugin.
- A loopback Vite preview serving the emitted HTML, JavaScript, and CSS with
  successful HTTP responses and the expected MIME types.
- Application text in the emitted JavaScript and a compiled Tailwind `underline`
  utility in the emitted CSS.

The [recorded Linux x64 result](evidence/framework-smoke-linux-x64.json) passed
with Node.js 24.18.0, the default deny policy, and install readiness `ready`.
It used an existing store; it is not a cold-install benchmark. The application
installed 56 selected packages. Its exact source revision, filesystem type,
script and lock hashes, command timings, and HTTP asset hashes are in the JSON
record. Registry traffic uses `https://registry.npmjs.org/`; application preview
traffic uses only `http://127.0.0.1` on an ephemeral port.

This is evidence for these pinned versions and the recorded platform. It does
not establish universal framework compatibility, browser hydration or
interaction behavior, lifecycle script execution, physical disk savings, or
HTTP request counts.

The fixture follows the primary documentation for
[React server rendering](https://react.dev/reference/react-dom/server/renderToStaticMarkup),
[Vite builds](https://vite.dev/guide/) and
[preview](https://vite.dev/guide/static-deploy),
[Vitest](https://vitest.dev/guide/), and
[Tailwind's Vite integration](https://tailwindcss.com/docs/installation/using-vite).
