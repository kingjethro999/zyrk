const installCommand = "npm install --global zyrk";

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      z<span>·</span>
    </span>
  );
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Zyrk home">
          <Mark />
          <span>zyrk</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#principles">Principles</a>
          <a href="https://github.com/kingjethro999/zyrk">GitHub</a>
        </nav>
        <a className="header-cta" href="#get-started">
          Get started <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> A package manager for the npm ecosystem
          </p>
          <h1>
            Keep your packages close. Keep your projects <em>clean.</em>
          </h1>
          <p className="hero-description">
            Zyrk verifies package sources once and reuses compatible dependency
            contexts across your projects. Your apps keep ordinary Node imports.
          </p>
          <div className="hero-actions" id="get-started">
            <a className="button button-primary" href="#install">
              Install Zyrk <span aria-hidden="true">↓</span>
            </a>
            <a
              className="button button-secondary"
              href="https://github.com/kingjethro999/zyrk"
            >
              Explore the source <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="pre-release">
            <span aria-hidden="true">◈</span> Pre-release software — check the
            compatibility notes before adopting.
          </p>
        </div>

        <div className="terminal" aria-label="Example Zyrk installation output">
          <div className="terminal-topbar">
            <div className="window-controls" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span>your-project — zsh</span>
            <span className="terminal-live">
              <i /> ready
            </span>
          </div>
          <div className="terminal-body">
            <p>
              <span className="prompt">$</span> zyrk install
            </p>
            <p className="terminal-muted">zyrk: Preparing installation</p>
            <p className="terminal-muted">zyrk: Verifying package sources</p>
            <p className="terminal-muted">
              zyrk: Preparing shared realizations
            </p>
            <p className="terminal-muted">zyrk: Linking project dependencies</p>
            <div className="terminal-rule" />
            <p className="terminal-success">
              <span>✓</span> Installed from the verified shared store.
            </p>
            <p className="terminal-hint">
              Your project still uses <code>node_modules</code> and normal
              imports.
            </p>
            <p className="terminal-cursor">
              <span className="prompt">$</span> <i />
            </p>
          </div>
          <div className="terminal-foot">
            <span>EXAMPLE OUTPUT</span>
            <span>NO CUSTOM LOADER REQUIRED</span>
          </div>
        </div>
        <div className="hero-orbit orbit-one" aria-hidden="true" />
        <div className="hero-orbit orbit-two" aria-hidden="true" />
      </section>

      <section className="principle-strip" aria-label="Zyrk principles">
        <div>
          <span>01</span>
          <p>One verified source store per user</p>
        </div>
        <div>
          <span>02</span>
          <p>Separate versions and dependency contexts</p>
        </div>
        <div>
          <span>03</span>
          <p>Ordinary project structure and imports</p>
        </div>
      </section>

      <section className="how-section section-wrap" id="how-it-works">
        <div className="section-heading">
          <p className="eyebrow">A familiar workflow, a shared store</p>
          <h2>
            Use your packages.
            <br />
            <em>Skip the repeated copies.</em>
          </h2>
        </div>
        <div className="steps-grid">
          <article className="step-card">
            <span className="step-number">01 / RESOLVE</span>
            <div className="step-symbol symbol-resolve" aria-hidden="true">
              <span>◇</span>
            </div>
            <h3>Lock the graph</h3>
            <p>
              Zyrk selects exact package versions and records a portable
              lockfile for the project.
            </p>
          </article>
          <article className="step-card">
            <span className="step-number">02 / VERIFY</span>
            <div className="step-symbol symbol-verify" aria-hidden="true">
              <span>✓</span>
            </div>
            <h3>Verify the sources</h3>
            <p>
              Package archives are checked before they become reusable content
              in your user store.
            </p>
          </article>
          <article className="step-card">
            <span className="step-number">03 / REUSE</span>
            <div className="step-symbol symbol-reuse" aria-hidden="true">
              <span>↗</span>
            </div>
            <h3>Link the project</h3>
            <p>
              Compatible dependency contexts are shared across projects, while
              each project keeps its own selection.
            </p>
          </article>
        </div>
      </section>

      <section className="trust-section" id="principles">
        <div className="trust-inner section-wrap">
          <div>
            <p className="eyebrow">Careful by default</p>
            <h2>
              Safety is part of
              <br />
              <em>the install.</em>
            </h2>
          </div>
          <div className="trust-list">
            <article>
              <span>01</span>
              <div>
                <h3>Exact means exact</h3>
                <p>
                  Frozen installs use the recorded graph. A cached package never
                  replaces a different selection.
                </p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Builds need a decision</h3>
                <p>
                  Lifecycle scripts require review and explicit approval. Shared
                  storage is not a sandbox.
                </p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Projects stay portable</h3>
                <p>
                  The lockfile records package selections, not paths to your
                  personal shared store.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="install-section section-wrap" id="install">
        <div className="install-copy">
          <p className="eyebrow">Start with one command</p>
          <h2>
            Try it in
            <br />
            <em>your project.</em>
          </h2>
          <p>
            Install the CLI, then use Zyrk where you normally install project
            dependencies. Node.js 24 or newer is required.
          </p>
          <a
            className="text-link"
            href="https://github.com/kingjethro999/zyrk#readme"
          >
            Read the getting-started guide <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="install-card">
          <div className="install-card-head">
            <span>TERMINAL</span>
            <span>01 / 02</span>
          </div>
          <div className="command-row">
            <span className="command-index">01</span>
            <code>{installCommand}</code>
          </div>
          <div className="command-row">
            <span className="command-index">02</span>
            <code>zyrk install</code>
          </div>
          <div className="install-card-foot">
            <span className="status-dot" /> npm bootstraps the CLI. Zyrk
            installs project packages.
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <a className="brand" href="#top">
          <Mark />
          <span>zyrk</span>
        </a>
        <p>
          From snpm to nexu to zyrk. The name changed; the shared-store idea
          stayed.
        </p>
        <div>
          <a href="https://github.com/kingjethro999/zyrk">GitHub</a>
          <a href="https://www.npmjs.com/package/zyrk">npm</a>
          <a href="https://github.com/kingjethro999/zyrk/blob/main/SECURITY.md">
            Security
          </a>
        </div>
      </footer>
    </main>
  );
}
