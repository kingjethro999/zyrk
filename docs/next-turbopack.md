# Explicit Next.js Turbopack configuration

A ready shared Next.js installation can opt into the external-store adapter:

```sh
cd web
zyrk next --turbopack
zyrk run build
zyrk run start -- --port 3000
# Or, during development:
zyrk run dev
```

This command edits configuration only when explicitly invoked. Ordinary `create`,
`install`, `run`, and `exec` commands keep their existing configuration behavior.
This initial adapter targets standalone projects with the native single-project
lock schema; workspace importers and private build/patch generations are outside
its verified scope. It accepts stable Next.js 16.4.x through 16.x, requires a ready shared installation
matching its manifest and lock, verifies the installed Next dependency closure,
and rejects Windows. The recorded framework check covers Linux x64 and Next.js
16.4.2 only; accepting another 16.x version is not evidence that every version or
feature works.

Next.js 16.4 introduced the experimental
[`turbopackAdditionalRoots` option](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#additional-roots-experimental)
for symbolic links to external packages. The adapter keeps `turbopack.root` at
this project directory and adds the installed store's **realizations** directory
as the named `zyrkStore` additional root. It does not expand the main root to a
home directory or filesystem root. Store and project roots must be separate;
a store nested under the project does not need this external-store adapter and
is refused before configuration is edited.

For a TypeScript application, the command preserves the original bytes in
`next.config.zyrk-original.ts`, creates a portable CommonJS adapter plus its
TypeScript declaration, and replaces `next.config.ts` with a small wrapper.
Equivalent wrappers support `next.config.mjs` and CommonJS/ES-module
`next.config.js`. Exactly one supported configuration must exist. The original
backup is created read-only, never overwritten. Existing unrelated backup or
adapter files cause a refusal. Repeating the command against its unchanged
wrapper returns `changed: false`.

The wrapper preserves the original configuration's other fields, promises,
configuration functions, and phase/context arguments. Original configuration code
runs when Next loads it, not while zyrk edits it. Next's TypeScript wrapper uses an
extensionless original import, so the generated application's normal TypeScript
settings need no changes. Only the strict root and named additional root are
managed. An existing conflicting `zyrkStore` entry must be resolved by the user.

Commit the wrapper, original configuration, adapter, and declaration together.
They contain no machine-specific absolute store paths. At each Next startup, the
adapter reads the untracked local install state, checks the installed lock and
Next link, and discovers the current local store path. Each coworker runs
`zyrk install` in their checkout. The package lock is not rewritten by this
command. Restore the original configuration from the backup to stop using the
wrapper; review or archive the associated adapter files before enabling it again.

The managed wrapper needs local zyrk install state and the shared store at every
Next startup. **Do not copy it unchanged into a self-contained deployment.**
Before preparing an output that must run without the developer store, restore the
original active configuration and rebuild. For the TypeScript fixture:

```sh
cp next.config.zyrk-original.ts next.config.ts
zyrk run build -- --webpack
```

For a JavaScript or MJS configuration, use its corresponding original backup.
Keep or archive the backup and adapter files; no automatic fallback changes the
selected bundler. Restoration returns to the explicit Webpack workflow; it does
not establish Next standalone/export compatibility. This Turbopack gate excludes
`zyrk deploy`, Docker runtime output, and Next `output: "standalone"`.

The option remains experimental upstream. Additional roots affect Next's output
tracing, and build machines need their own installed store. This evidence does
not establish standalone deployment/export compatibility, macOS compatibility,
Windows support, arbitrary Next.js features, or compatibility with every future
release. Explicit Webpack remains available without this adapter:
`zyrk run build -- --webpack` and `zyrk run dev -- --webpack`.

The [recorded Linux check](evidence/next-turbopack-linux.json) used the emitted
zyrk JavaScript CLI, Next.js 16.4.2, React/React DOM 19.3.0, TypeScript 5.9.3,
and a deterministic local component fixture with no Google Fonts downloads.
The store was outside the strict project root. Turbopack production compilation,
TypeScript checking, static generation, production HTTP 200, and Turbopack
development HTTP 200 passed with the expected page marker. An npm executable
that records and rejects invocations was first on PATH; it recorded none.
