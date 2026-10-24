import Link from "next/link";
import { bootstrapCommand, platformGuidance } from "../lib/platform-guidance";

const statusLabel = {
  "initial-target": "INITIAL TARGET",
  "evidence-gated": "EVIDENCE GATED",
  unavailable: "UNAVAILABLE",
} as const;

export function PlatformGuide() {
  return (
    <section
      className="platform-section page-section"
      id="platforms"
      aria-labelledby="platform-heading"
    >
      <div className="platform-heading">
        <p className="eyebrow">Choose with the platform boundary visible</p>
        <h2 id="platform-heading">
          Bootstrap broadly.
          <br />
          <em>Adopt only where verified.</em>
        </h2>
        <p>
          Zyrk requires Node.js 24 or newer. npm installs the CLI once; Zyrk
          installs project dependencies only on platforms whose native store
          contract is ready.
        </p>
      </div>
      <div className="platform-grid">
        {platformGuidance.map((platform) => (
          <article
            className={`platform-card is-${platform.status}`}
            key={platform.id}
          >
            <div className="platform-card-header">
              <h3>{platform.name}</h3>
              <span>{statusLabel[platform.status]}</span>
            </div>
            <p>{platform.summary}</p>
            <dl>
              <div>
                <dt>CLI bootstrap</dt>
                <dd>
                  <code>{bootstrapCommand}</code>
                </dd>
              </div>
              <div>
                <dt>Project install</dt>
                <dd>
                  {platform.projectCommand ? (
                    <code>{platform.projectCommand}</code>
                  ) : (
                    <span>Do not adopt yet</span>
                  )}
                </dd>
              </div>
            </dl>
            <small>{platform.evidence}</small>
          </article>
        ))}
      </div>
      <Link className="text-link" href="/docs#compatibility">
        Read the compatibility evidence <span aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}
