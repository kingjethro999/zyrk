# Next.js compatibility

The recorded Linux x64 check uses Node 24.18.0, create-next-app/Next.js 16.4.2,
React/React DOM 19.3.0, and TypeScript 5.9.3. Native scaffolding and installation,
Webpack production builds, production HTTP serving, and Webpack development HTTP
serving passed with an executable that rejects and records every npm invocation
first on PATH. No npm invocation was recorded. The installed graph was `ready`
with 31 packages; no lifecycle scripts were ignored or approved.

Use the explicit Webpack option when dependencies link to a store outside the
project root:

```sh
zyrk create next-app@16.4.2 web --yes --typescript --app --no-tailwind --no-eslint --no-react-compiler --no-agent-feedback --no-agents-md --disable-git
cd web
zyrk run dev -- --webpack
```

For production:

```sh
zyrk run build -- --webpack
zyrk run start -- --port 3000
```

`create next-app` supplies the official `--skip-install` option, then installs the
generated project through zyrk. An explicit user `--skip-install` leaves the
project uninstalled. Upstream may still print “Using npm”; that label describes
its selected package-manager mode, while installation is skipped. The native
adapter accepts resolved stable 15.x and 16.x initializer versions, whose
[official CLI source](https://github.com/vercel/next.js/blob/v15.0.0/packages/create-next-app/index.ts)
and [16.x source](https://github.com/vercel/next.js/blob/v16.0.0/packages/create-next-app/index.ts)
provide the flag. End-to-end framework evidence here covers 16.4.2 only. Supplying
that flag also selects configuration defaults in 16.4.2; use explicit initializer
options to customize them. The project-name prompt remains available.

Turbopack is not supported by this recorded external-store layout. With the
fixture's `turbopack.root` set to its project directory, the default build exited
1 because it could not resolve `next/package.json` outside that root. Next.js
states that files outside the workspace root are not compiled. See its
[root-directory documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory).
An earlier build accidentally inferred the enclosing checkout as its root and
therefore included the test store; that pass is excluded from the compatibility
gate. zyrk does not silently change the generated application's bundler.

The deterministic smoke replaced the generated Google Fonts layout and starter
page with local React components, retained the generated CSS and configuration
options, and added an explicit project Turbopack root to avoid the enclosing
checkout's lockfile. Both production and development returned HTTP 200 with the
expected page marker. The unmodified starter may download Google Fonts during
its build. This check does not establish compatibility for every Next.js
version, feature, platform, native addon, or deployment mode.

[Machine-readable evidence](evidence/next-linux.json) records commands, selected
versions, fixture inputs, lock digest, filesystem properties, and the tested
source fingerprint. Initial cold attempts encountered a resolver deadline before
the timeout correction and transient registry download timeouts; verified source
commits were retained and later attempts completed. Large logs and the local
store are not part of this evidence artifact.
