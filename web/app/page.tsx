import type { ReactNode } from "react";
import { CopyCommand } from "./copy-command";

const repo = "https://github.com/kingjethro999/zyrk";
const bootstrap = "npm install --global zyrk";

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M7 9h18v4L13 23h12" />
        <path d="M7 23h4" />
      </svg>
    </span>
  );
}

function FeatureIcon({ kind }: { kind: string }) {
  const paths: Record<string, ReactNode> = {
    store: (
      <>
        <path d="m4 8 8-4 8 4-8 4-8-4Z" />
        <path d="M4 8v8l8 4 8-4V8M12 12v8" />
      </>
    ),
    graph: (
      <>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M8 7.5 10.8 16M16 7.5 13.2 16M8 6h8" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    check: (
      <>
        <path d="m4 12 5 5L20 6" />
        <circle cx="12" cy="12" r="9" />
      </>
    ),
  };

  return (
    <span className="feature-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths[kind] ?? paths.store}
      </svg>
    </span>
  );
}

const features = [
  {
    icon: "store",
    label: "SHARED STORAGE",
    title: "One verified source store",
    body: "Package files are verified and kept in a store scoped to your OS account, ready for compatible projects to reuse.",
  },
  {
    icon: "graph",
    label: "DEPENDENCY CONTEXTS",
    title: "Exact graphs stay separate",
    body: "Different versions and peer-dependency contexts get distinct realizations, so one project cannot change another project’s selection.",
  },
  {
    icon: "lock",
    label: "REVIEWED BUILDS",
    title: "Scripts need a decision",
    body: "Dependency lifecycle scripts are reviewed before execution. Approved builds use private project files; approval is not a sandbox.",
  },
  {
    icon: "globe",
    label: "PORTABLE LOCKS",
    title: "No personal store paths",
    body: "The portable lock records package selections rather than links into one developer’s home directory or machine-specific store.",
  },
  {
    icon: "terminal",
    label: "FAMILIAR RUNTIME",
    title: "Keep normal Node imports",
    body: "Projects keep node_modules and ordinary CJS, ESM, and package-script workflows. No custom loader or import rewrite is required.",
  },
  {
    icon: "check",
    label: "RECOVERABLE CHANGES",
    title: "Install as a transaction",
    body: "Lockfile and project changes are journaled. Failed resolution, source verification, or approved builds leave the prior graph active.",
  },
];

const commands = [
  { command: "zyrk install", detail: "Install the project graph" },
  { command: "zyrk add prettier", detail: "Add a package to the project" },
  { command: "zyrk dev", detail: "Run a declared project script" },
  {
    command: "zyrk create next-app web",
    detail: "Scaffold, then install with Zyrk",
  },
];

function StoreIllustration() {
  return (
    <div
      className="store-illustration"
      role="img"
      aria-label="A verified shared package source connects to independent project dependency graphs"
    >
      <div className="illustration-grid" />
      <svg
        className="connection-lines"
        viewBox="0 0 660 470"
        fill="none"
        aria-hidden="true"
      >
        <path d="M330 205C260 163 220 135 143 121M330 205c71-42 110-70 187-84M330 245c-62 59-111 82-190 117m190-117c61 59 110 82 190 117" />
        <circle cx="143" cy="121" r="5" />
        <circle cx="517" cy="121" r="5" />
        <circle cx="140" cy="362" r="5" />
        <circle cx="520" cy="362" r="5" />
      </svg>
      <div className="source-node">
        <span className="source-glyph">
          <BrandMark />
        </span>
        <span className="node-kicker">ZYRK USER STORE</span>
        <strong>Verified sources</strong>
        <span className="node-caption">Reusable package content</span>
      </div>
      <div className="project-node node-one">
        <span className="node-kicker">PROJECT 01</span>
        <strong>web-app</strong>
        <span className="node-caption">
          <i /> node_modules
        </span>
      </div>
      <div className="project-node node-two">
        <span className="node-kicker">PROJECT 02</span>
        <strong>api-service</strong>
        <span className="node-caption">
          <i /> node_modules
        </span>
      </div>
      <div className="project-node node-three">
        <span className="node-kicker">PROJECT 03</span>
        <strong>design-system</strong>
        <span className="node-caption">
          <i /> node_modules
        </span>
      </div>
      <div className="project-node node-four">
        <span className="node-kicker">PROJECT 04</span>
        <strong>tooling</strong>
        <span className="node-caption">
          <i /> node_modules
        </span>
      </div>
      <div className="float-note note-top">
        <span>✓</span> source integrity checked
      </div>
      <div className="float-note note-bottom">
        <span>↗</span> dependency context preserved
      </div>
      <div className="illustration-caption">
        ONE USER STORE <span>·</span> PROJECT-LOCAL GRAPHS
      </div>
    </div>
  );
}

function TerminalExample() {
  return (
    <div
      className="terminal-card"
      aria-label="Example Zyrk installation progress"
    >
      <div className="terminal-titlebar">
        <span className="terminal-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>project — zsh</span>
        <span className="terminal-tag">ZYRK</span>
      </div>
      <div className="terminal-content">
        <p>
          <span className="shell-prompt">$</span> zyrk install
        </p>
        <p className="terminal-phase">› zyrk: Preparing installation</p>
        <p className="terminal-phase">› zyrk: Verifying package sources</p>
        <p className="terminal-phase">› zyrk: Preparing shared realizations</p>
        <p className="terminal-phase">› zyrk: Linking project dependencies</p>
        <div className="terminal-divider" />
        <p className="terminal-done">
          ✓ Installed from the verified shared store.
        </p>
        <p className="terminal-note">
          Your project still uses <code>node_modules</code> and normal imports.
        </p>
        <p className="terminal-end">
          <span className="shell-prompt">$</span>
          <i />
        </p>
      </div>
      <div className="terminal-bottom">
        <span>EXAMPLE OUTPUT</span>
        <span>PROJECT IMPORTS UNCHANGED</span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main id="top">
      <div className="nav-rail">
        <header className="site-header">
          <a className="brand" href="#top" aria-label="Zyrk home">
            <BrandMark />
            <span>zyrk</span>
            <span className="release-chip">PRE-RELEASE</span>
          </a>
          <nav className="site-nav" aria-label="Main navigation">
            <a href="#features">Features</a>
            <a href="#workflow">How it works</a>
            <a href="#commands">Commands</a>
            <a href={`${repo}#readme`}>Docs</a>
          </nav>
          <div className="header-actions">
            <a className="github-link" href={repo} aria-label="Zyrk on GitHub">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.76-1.32-3.76-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.76 2.74 4.5 1.83.1-.72.39-1.22.71-1.5-2.48-.28-5.09-1.24-5.09-5.53 0-1.22.44-2.21 1.15-2.99-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.14a10.6 10.6 0 0 1 5.55 0c2.11-1.44 3.04-1.14 3.04-1.14.61 1.54.23 2.68.12 2.96.71.78 1.14 1.77 1.14 2.99 0 4.3-2.62 5.25-5.11 5.52.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"
                />
              </svg>
            </a>
            <a className="header-cta" href="#get-started">
              Get started <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>
      </div>

      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <p className="eyebrow">
              <span /> NPM-COMPATIBLE PACKAGE MANAGEMENT
            </p>
            <h1>
              One verified store.
              <br />
              Projects that stay <em>yours.</em>
            </h1>
            <p className="hero-description">
              Zyrk reuses verified package sources and compatible dependency
              contexts across your projects. Keep your normal{" "}
              <code>node_modules</code>, package scripts, and Node imports.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#get-started">
                Get started <span aria-hidden="true">→</span>
              </a>
              <a className="button button-secondary" href={`${repo}#readme`}>
                Read the guide
              </a>
            </div>
            <div className="quick-install" id="get-started">
              <div className="quick-install-label">
                <span aria-hidden="true">⌘</span> Bootstrap the CLI
              </div>
              <CopyCommand command={bootstrap} />
              <p>
                Use <code>zyrk install</code> to install your project
                dependencies.
              </p>
            </div>
            <p className="pre-release-note">
              <span>●</span> Pre-release software. Review compatibility notes
              before adopting.
            </p>
          </div>
          <StoreIllustration />
        </div>
      </section>

      <section className="trust-rail" aria-label="Zyrk design principles">
        <div>
          <span>01</span>
          <strong>Verified sources</strong>
        </div>
        <div>
          <span>02</span>
          <strong>Exact project graphs</strong>
        </div>
        <div>
          <span>03</span>
          <strong>Ordinary Node.js imports</strong>
        </div>
      </section>

      <section className="features-section page-section" id="features">
        <div className="section-intro">
          <p className="eyebrow">
            A familiar workflow, a different storage model
          </p>
          <h2>
            Package management,
            <br />
            <em>with the boundaries in view.</em>
          </h2>
          <p>
            Zyrk keeps source verification, dependency context, and project
            files explicit—without asking application code to change how it
            imports packages.
          </p>
        </div>
        <div className="features-grid">
          {features.map((feature, index) => (
            <article className="feature-card" key={feature.title}>
              <div className="feature-card-top">
                <FeatureIcon kind={feature.icon} />
                <span>0{index + 1}</span>
              </div>
              <p className="card-label">{feature.label}</p>
              <h3>{feature.title}</h3>
              <p className="card-body">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="workflow-inner page-section">
          <div className="workflow-heading">
            <p className="eyebrow">What happens during install</p>
            <h2>
              Resolve. Verify.
              <br />
              <em>Link the project.</em>
            </h2>
            <p>
              The store is shared per OS user. The selected dependency graph and
              its links remain specific to each project.
            </p>
            <a
              className="text-link"
              href={`${repo}#install-project-dependencies`}
            >
              Explore the install model <span>↗</span>
            </a>
          </div>
          <div className="workflow-steps">
            <article>
              <span className="step-count">01</span>
              <div>
                <h3>Resolve exact selections</h3>
                <p>
                  Read the manifest and portable lock, then prepare a finite
                  dependency graph.
                </p>
              </div>
              <span className="step-token">package.json → lock</span>
            </article>
            <article>
              <span className="step-count">02</span>
              <div>
                <h3>Verify package sources</h3>
                <p>
                  Check archive integrity and paths before source content can
                  enter the shared store.
                </p>
              </div>
              <span className="step-token">integrity → source</span>
            </article>
            <article>
              <span className="step-count">03</span>
              <div>
                <h3>Build compatible contexts</h3>
                <p>
                  Keep versions and peer contexts isolated; reuse only matching
                  verified realizations.
                </p>
              </div>
              <span className="step-token">graph → realizations</span>
            </article>
            <article>
              <span className="step-count">04</span>
              <div>
                <h3>Link project dependencies</h3>
                <p>
                  Expose the selected graph through the project’s normal
                  node_modules layout.
                </p>
              </div>
              <span className="step-token">links → imports</span>
            </article>
          </div>
        </div>
      </section>

      <section className="commands-section page-section" id="commands">
        <div className="commands-heading">
          <p className="eyebrow">Use the commands you came for</p>
          <h2>
            Keep your workflow.
            <br />
            <em>Change the install.</em>
          </h2>
          <p>
            Use Zyrk to add packages, run project scripts, or scaffold an app.
            The project keeps its usual package files and runtime.
          </p>
          <a className="text-link" href={`${repo}#try-the-current-cli`}>
            Browse the command guide <span>↗</span>
          </a>
        </div>
        <div className="command-showcase">
          <div className="showcase-header">
            <span>ZYRK IN YOUR PROJECT</span>
            <span>NODE.JS WORKFLOW</span>
          </div>
          {commands.map((item, index) => (
            <div className="showcase-row" key={item.command}>
              <span className="showcase-index">0{index + 1}</span>
              <div>
                <code>{item.command}</code>
                <span>{item.detail}</span>
              </div>
              <span className="showcase-arrow" aria-hidden="true">
                ↗
              </span>
            </div>
          ))}
          <TerminalExample />
        </div>
      </section>

      <section className="principles-section page-section" id="principles">
        <div className="principles-title">
          <p className="eyebrow">The Zyrk approach</p>
          <h2>
            Reuse content.
            <br />
            <em>Respect context.</em>
          </h2>
        </div>
        <div className="principles-grid">
          <article>
            <span className="principle-mark">A</span>
            <h3>Shared source, separate instance</h3>
            <p>
              Verified file content can be shared. Dependency-aware realizations
              stay distinct when peer bindings or versions differ.
            </p>
          </article>
          <article>
            <span className="principle-mark">B</span>
            <h3>Portable project state</h3>
            <p>
              Locks describe selected packages and platform variants; they do
              not encode another developer’s home directory or store path.
            </p>
          </article>
          <article>
            <span className="principle-mark">C</span>
            <h3>Honest readiness</h3>
            <p>
              Unapproved builds remain unbuilt. Zyrk reports that state and
              gives you a deliberate path to review and approve scripts.
            </p>
          </article>
          <article>
            <span className="principle-mark">D</span>
            <h3>Measure before claiming</h3>
            <p>
              Performance and storage savings need reproducible comparisons.
              Zyrk does not promise a speedup without those measurements.
            </p>
          </article>
        </div>
      </section>

      <section className="closing-section">
        <div className="closing-art" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="closing-content">
          <p className="eyebrow">Start with your next project</p>
          <h2>
            Make shared storage
            <br />
            <em>part of your workflow.</em>
          </h2>
          <p>
            Bootstrap the Zyrk CLI, then install your project graph with Zyrk
            itself.
          </p>
          <div className="closing-actions">
            <a className="button button-light" href={`${repo}#readme`}>
              Read the documentation <span>↗</span>
            </a>
            <a className="button button-glass" href={repo}>
              View Zyrk on GitHub <span>↗</span>
            </a>
          </div>
          <div className="closing-command">
            <code>npm install --global zyrk</code>
            <span>CLI bootstrap</span>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-main">
          <div className="footer-brand-block">
            <a className="brand footer-brand" href="#top">
              <BrandMark />
              <span>zyrk</span>
            </a>
            <p>
              An npm-compatible package manager built around verified, shared
              package storage.
            </p>
            <span className="footer-status">
              <i /> PRE-RELEASE · NODE.JS 24+
            </span>
          </div>
          <div className="footer-column">
            <h3>Documentation</h3>
            <a href={`${repo}#try-the-current-cli`}>Getting started</a>
            <a href={`${repo}#install-project-dependencies`}>
              Install and lockfiles
            </a>
            <a href={`${repo}#run-project-scripts`}>Run scripts</a>
            <a href={`${repo}#workspaces`}>Workspaces</a>
          </div>
          <div className="footer-column">
            <h3>Project</h3>
            <a href={repo}>GitHub repository</a>
            <a href={`${repo}/releases`}>Releases</a>
            <a href={`${repo}/issues`}>Report an issue</a>
            <a href={`${repo}/blob/main/SECURITY.md`}>Security policy</a>
          </div>
          <div className="footer-column">
            <h3>Package</h3>
            <a href="https://www.npmjs.com/package/zyrk">zyrk on npm</a>
            <a href={`${repo}/blob/main/LICENSE`}>MIT license</a>
            <a href={`${repo}/blob/main/README.md`}>README</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 Zyrk contributors</span>
          <span>Built for ordinary Node.js projects.</span>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
