import { useState } from "react";
import type { PortalView } from "../services/portal.server";

function minutesAgo(iso: string | null, nowIso: string): string {
  if (!iso) return "updated as orders arrive";
  const minutes = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60000));
  if (minutes < 1) return "updated just now";
  if (minutes < 120) return `updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `updated ${Math.round(minutes / 60)} hours ago`;
}

const KIND: Record<string, string> = { flyer: "Flyer", email_copy: "Email text", social_image: "Social image", other: "File" };

/** One fundraiser as an organizer sees it. Counts only, never order or customer details. */
export function PortalFundraiserView({ view, qrSvg, now, preview }: { view: PortalView; qrSvg: string | null; now: string; preview?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      {preview && <div className="note">Admin preview: this is what the organizer sees. Read-only; no session was created.</div>}
      <div className="card">
        <span className="badge">{view.statusLabel}</span>
        <h1>{view.organization}</h1>
        <div className="muted">
          {view.team} · {view.startDate} to {view.endDate} · {view.dayStatus}
        </div>
        {view.statusMessage && <p>{view.statusMessage}</p>}
      </div>

      <div className="card">
        <div className="row">
          <div>
            <div className="muted">Items sold</div>
            <div className="big">{view.units}</div>
          </div>
          <div>
            <div className="muted">Raised so far</div>
            <div className="big">{view.estimatedRaised}</div>
          </div>
        </div>
        <p className="muted">
          Estimated, final after settlement · {view.ratePerItem} per item · {minutesAgo(view.dataAsOf, now)}
        </p>
      </div>

      {view.suggestion && (
        <div className="card">
          <h2>This week</h2>
          <p>{view.suggestion}</p>
        </div>
      )}

      {view.shortLink && (
        <div className="card">
          <h2>Your link</h2>
          <div className="link-box">
            <code>{view.shortLink}</code>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(view.shortLink!).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {qrSvg && (
            <div className="qr" style={{ marginTop: 12 }}>
              {/* Generated on our server from the short link above. */}
              <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
              <div className="muted">Scan to open the product page</div>
            </div>
          )}
        </div>
      )}

      {view.assets.length > 0 && (
        <div className="card">
          <h2>Downloads</h2>
          <ul className="assets">
            {view.assets.map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.title}
                </a>{" "}
                <span className="muted">({KIND[a.kind] ?? a.kind})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Payout</h2>
        <p className="muted">{view.payoutStatus}</p>
      </div>

      <div className="card">
        <h2>Need help?</h2>
        <p>
          Email <a href={`mailto:${view.helpEmail}`}>{view.helpEmail}</a>
        </p>
      </div>
    </>
  );
}
