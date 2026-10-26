import type { Metadata } from "next";
import Link from "next/link";

const repository = "https://github.com/kingjethro999/zyrk";

export const metadata: Metadata = {
  title: "Zyrk documentation — Getting started and compatibility",
  description:
    "Install Zyrk, understand its shared store and lockfiles, browse commands, and check current platform compatibility limits.",
};

const commands = [
  ["zyrk install", "Install the project graph from its lock or resolve it."],
  [
    "zyrk install --frozen-lockfile",
    "Require a compatible lock without refreshing selections.",
  ],
  ["zyrk add prettier", "Add a dependency to the current project."],
  ["zyrk remove prettier", "Remove a direct dependency and refresh the graph."],
  ["zyrk update", "Update dependencies within their declared ranges."],
  ["zyrk dev", "Run the declared dev script from its project directory."],
  [
    "zyrk exec tsc --noEmit",
    "Run an installed executable without fetching a tool.",
  ],
  ["zyrk dlx <package>", "Fetch and run a temporary tool environment."],
  [
    "zyrk create next-app web",
    "Scaffold a supported initializer and install with Zyrk.",
  ],
  [
    "zyrk approve-builds",
    "Inspect lifecycle build candidates and their exact sources.",
  ],
  ["zyrk store gc --dry-run", "Preview eligible cleanup before applying it."],
  ["zyrk --help", "Show the command list and global options."],
];

const compatibility = [
  {
    area: "Node.js",
    status: "Node.js 24 or newer is required.",
    notes:
      "The published package uses compiled JavaScript and requires no native toolchain to install.",
  },
  {
    area: "Linux",
    status: "Initial target; Ubuntu CI gate is available.",
    notes:
      "Use a supported local filesystem. The store is scoped to the current OS user.",
  },
  {
    area: "macOS",
    status:
      "Full check gate runs in CI; native release support remains evidence-gated.",
    notes:
      "A passing CI check is not a complete filesystem and framework compatibility claim.",
  },
  {
    area: "Windows",
    status: "Native shared-store installs are currently unavailable.",
    notes:
      "CLI and packaging contract checks run, but shared installation is blocked pending an account-isolating ACL implementation.",
  },
  {
    area: "Next.js",
    status: "Pinned Linux x64 evidence for Next.js 16.4.2.",
    notes:
      "Webpack is verified; Turbopack requires the explicit `zyrk next --turbopack` adapter. This does not cover every Next version or platform.",
  },
  {
    area: "Native exports",
    status: "Narrow Linux x64 ELF64 N-API copy recipe only.",
    notes:
      "Other native formats, external libraries, loader paths, and host-path-dependent build outputs are unsupported.",
  },
  {
    area: "Other frameworks",
    status: "Use only pinned evidence listed in the compatibility guides.",
    notes:
      "Hermetic package fixtures do not establish universal framework or device support.",
  },
];

function Brand() {
  return (
    <Link className="docs-brand" href="/" aria-label="Zyrk home">
      <span className="docs-brand-mark" aria-hidden="true">
        z
      </span>
      <span>zyrk</span>
    </Link>
  );
}

function SourceLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}

export default function DocsPage() {
  return (
    <main className="docs-page">
      <a className="docs-skip-link" href="#docs-content">
        Skip to documentation
      </a>
      <header className="docs-header">
        <Brand />
        <nav aria-label="Documentation header">
          <Link href="/">Overview</Link>
          <a href={`${repository}#readme`} target="_blank" rel="noreferrer">
            GitHub README ↗
          </a>
        </nav>
      </header>

      <div className="docs-shell">
        <div className="docs-breadcrumb">
          <Link href="/">Home</Link>
          <span aria-hidden="true">/</span>
          <span>Documentation</span>
        </div>
        <header className="docs-hero">
          <p className="eyebrow">
            <span /> ZYRK DOCUMENTATION
          </p>
          <h1>
            Use Zyrk with
            <br />
            <em>the boundaries in view.</em>
          </h1>
          <p>
            Start with the supported workflow, then check what Zyrk does with
            your lockfile, shared store, lifecycle scripts, and platform.
          </p>
          <p className="docs-release-note">
            Pre-release software · Node.js 24+ · Compatibility is version- and
            platform-specific.
          </p>
        </header>

        <div className="docs-layout">
          <nav className="docs-toc" aria-label="On this page">
            <span>ON THIS PAGE</span>
            <a href="#getting-started">Getting started</a>
            <a href="#how-it-works">How it works</a>
            <a href="#commands">Command reference</a>
            <a href="#compatibility">Compatibility</a>
            <a href="#script-trust">Script trust</a>
            <a href="#troubleshooting">Troubleshooting</a>
            <a href="#sources">Sources and policies</a>
          </nav>

          <article className="docs-content" id="docs-content">
            <section id="getting-started" className="docs-section">
              <p className="docs-kicker">01 · FIRST INSTALL</p>
              <h2>Install the CLI, then install the project.</h2>
              <p>
                Use npm once to install the Zyrk executable. Use Zyrk for
                project dependencies:
              </p>
              <pre>
                <code>
                  {
                    "npm install --global zyrk@latest\nzyrk --version\nzyrk install"
                  }
                </code>
              </pre>
              <p>
                Run project commands from the directory whose{" "}
                <code>package.json</code> declares the script. For a script in{" "}
                <code>web/package.json</code>, use <code>cd web</code> before{" "}
                <code>zyrk dev</code>.
              </p>
              <aside className="docs-callout docs-callout-warning">
                <strong>Windows limitation</strong>
                <p>
                  Windows native shared-store installation is not available yet.
                  Windows CLI and packaging tests do not mean{" "}
                  <code>zyrk install</code> is supported there.
                </p>
              </aside>
            </section>

            <section id="how-it-works" className="docs-section">
              <p className="docs-kicker">02 · THE STORAGE MODEL</p>
              <h2>Share verified content. Keep project graphs separate.</h2>
              <p>
                Zyrk records portable selections in{" "}
                <code>package-lock.json</code>, verifies sources before use, and
                reuses compatible dependency contexts from a store scoped to
                your OS account. Each project keeps its ordinary{" "}
                <code>node_modules</code> layout and imports.
              </p>
              <ul>
                <li>
                  The lock records selections and platform variants, not another
                  developer’s home directory or store path.
                </li>
                <li>
                  Different versions and peer-dependency contexts stay separate;
                  only matching verified realizations are reused.
                </li>
                <li>
                  Install publishes project changes transactionally and retains
                  the previous active graph when a supported step fails.
                </li>
                <li>
                  Sharing files is not unique to Zyrk: pnpm also uses hard
                  links. Zyrk’s model and safety trade-offs are documented in
                  the project README.
                </li>
              </ul>
            </section>

            <section id="commands" className="docs-section">
              <p className="docs-kicker">03 · COMMANDS</p>
              <h2>Common project workflows</h2>
              <div className="docs-command-list">
                {commands.map(([command, description]) => (
                  <div className="docs-command-row" key={command}>
                    <code>{command}</code>
                    <span>{description}</span>
                  </div>
                ))}
              </div>
              <p>
                Use <code>zyrk &lt;script&gt;</code> as a shortcut for{" "}
                <code>zyrk run &lt;script&gt;</code>. Zyrk never installs
                packages globally; use npm directly for global tools. Native
                commands show focused usage, options, and examples with{" "}
                <code>zyrk &lt;command&gt; --help</code>; registry commands
                continue to show npm help.
              </p>
            </section>

            <section id="compatibility" className="docs-section">
              <p className="docs-kicker">04 · COMPATIBILITY</p>
              <h2>Check the tested boundary before adopting.</h2>
              <p>
                CI results, framework fixtures, and native store behavior are
                separate evidence. A successful typecheck or package fixture
                does not establish a supported platform.
              </p>
              <table className="docs-compat-table">
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Current status and limits</th>
                  </tr>
                </thead>
                <tbody>
                  {compatibility.map((item) => (
                    <tr key={item.area}>
                      <th scope="row">{item.area}</th>
                      <td>
                        <b>{item.status}</b>
                        <small>{item.notes}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section id="script-trust" className="docs-section">
              <p className="docs-kicker">05 · LIFECYCLE SCRIPTS</p>
              <h2>Review builds before they run.</h2>
              <p>
                Interactive install lets you select exact package build
                candidates. Press Enter to skip pending scripts. Headless
                installs also skip unapproved builds and report an intentionally
                unbuilt readiness state.
              </p>
              <p>
                <code>zyrk approve-builds</code> labels each exact source as
                pending, approved, or denied, shows its lifecycle commands, and
                names the policy scope behind that decision. A mandatory deny
                cannot be overridden and does not block approval of a separate
                permitted source.
              </p>
              <pre>
                <code>
                  {"zyrk approve-builds\nzyrk install\nzyrk rebuild --offline"}
                </code>
              </pre>
              <aside className="docs-callout">
                <strong>Approval is not a sandbox.</strong>
                <p>
                  Approved lifecycle scripts run with your OS account’s
                  permissions. Zyrk uses private project files for packages that
                  need writes; it does not confine arbitrary same-user code.
                </p>
              </aside>
              <p>
                Interactive and manual exact-source approvals are recorded in{" "}
                <code>zyrk-workspace.json</code>. User-level denies override
                project approvals.
              </p>
            </section>

            <section id="troubleshooting" className="docs-section">
              <p className="docs-kicker">06 · TROUBLESHOOTING</p>
              <h2>Start with the state Zyrk reports.</h2>
              <dl className="docs-troubleshooting">
                <div>
                  <dt>
                    <code>ZYRK_LOCK_MISMATCH</code>
                  </dt>
                  <dd>
                    Check that the manifest and lockfile belong together.
                    Restore the matching files or intentionally refresh
                    selections, then retry frozen install.
                  </dd>
                </div>
                <div>
                  <dt>Resolver deadline</dt>
                  <dd>
                    For <code>ZYRK_RESOLUTION_FAILED</code> with a
                    resolution-deadline message, increase{" "}
                    <code>ZYRK_RESOLVE_TIMEOUT_MS</code> (1–900000 ms). Request
                    and archive-download deadlines use{" "}
                    <code>ZYRK_REQUEST_TIMEOUT_MS</code> and{" "}
                    <code>ZYRK_FETCH_TIMEOUT_MS</code> (1–3600000 ms).
                  </dd>
                </div>
                <div>
                  <dt>
                    <code>ZYRK_OFFLINE_MISSING</code>
                  </dt>
                  <dd>
                    Reconnect to the configured registry and run{" "}
                    <code>zyrk install</code> to verify and cache required
                    sources. Retry offline after the online install succeeds.
                  </dd>
                </div>
                <div>
                  <dt>Script is not declared</dt>
                  <dd>
                    Run the command from the project that declares it, or use{" "}
                    <code>
                      zyrk run --workspace &lt;name&gt; &lt;script&gt;
                    </code>{" "}
                    from a workspace root.
                  </dd>
                </div>
                <div>
                  <dt>Install completed with builds skipped</dt>
                  <dd>
                    Review exact candidates with{" "}
                    <code>zyrk approve-builds</code>, then run{" "}
                    <code>zyrk rebuild --offline</code> when the sources and
                    commands are trusted.
                  </dd>
                </div>
                <div>
                  <dt>Need global package installation</dt>
                  <dd>
                    Zyrk intentionally rejects global installs. Use{" "}
                    <code>npm install --global &lt;package&gt;</code> directly.
                  </dd>
                </div>
              </dl>
              <p>
                Start with <code>zyrk doctor</code> for read-only project
                diagnostics. Use <code>zyrk repair</code> only when you intend
                to reconstruct the project from verified locked sources.
              </p>
            </section>

            <section id="sources" className="docs-section docs-sources">
              <p className="docs-kicker">07 · SOURCES</p>
              <h2>Read the detailed contract.</h2>
              <p>
                This site’s quick guide is maintained with the CLI source. The
                README and compatibility reports contain the detailed behavior,
                fixtures, and known limitations.
              </p>
              <div>
                <SourceLink href={`${repository}#readme`}>
                  Project README
                </SourceLink>
                <SourceLink
                  href={`${repository}/blob/main/docs/compatibility-gates.md`}
                >
                  Compatibility gates
                </SourceLink>
                <SourceLink
                  href={`${repository}/blob/main/docs/next-compatibility.md`}
                >
                  Next.js evidence
                </SourceLink>
                <SourceLink href={`${repository}/blob/main/SECURITY.md`}>
                  Security reporting
                </SourceLink>
              </div>
            </section>
          </article>
        </div>
      </div>

      <footer className="docs-footer">
        <Brand />
        <span>Pre-release · Node.js 24+</span>
        <Link href="/">Back to overview ↑</Link>
      </footer>
    </main>
  );
}
