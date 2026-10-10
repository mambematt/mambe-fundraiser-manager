import type { ReactNode } from "react";

// Plain, fast, mobile-first styling for the organizer portal (no Polaris here:
// the portal is outside Shopify admin).
export const PORTAL_CSS = `
  :root { --navy:#1f2a44; --ink:#1d1d1f; --muted:#6b7280; --line:#e5e7eb; --bg:#f7f6f3; --accent:#c8553d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family: Inter, -apple-system, system-ui, sans-serif; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 16px; }
  header.brand { background: var(--navy); color: #fff; padding: 14px 16px; }
  header.brand .inner { max-width:560px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; }
  header.brand a { color:#fff; text-decoration:none; font-size:14px; }
  .logo { font-weight:700; letter-spacing:.02em; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin:12px 0; }
  h1 { font-size:22px; margin:4px 0; } h2 { font-size:16px; margin:0 0 8px; }
  .muted { color:var(--muted); font-size:14px; }
  .big { font-size:32px; font-weight:700; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  .badge { display:inline-block; background:#eef2ff; color:var(--navy); border-radius:999px; padding:2px 10px; font-size:13px; font-weight:600; }
  .note { background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; padding:10px 12px; font-size:14px; }
  input[type=email] { width:100%; padding:12px; border:1px solid var(--line); border-radius:10px; font-size:16px; }
  button, .button { display:inline-block; background:var(--accent); color:#fff; border:0; border-radius:10px; padding:12px 16px; font-size:16px; font-weight:600; text-decoration:none; cursor:pointer; }
  button.secondary { background:#fff; color:var(--navy); border:1px solid var(--line); }
  .link-box { display:flex; gap:8px; align-items:center; } .link-box code { flex:1; overflow:hidden; text-overflow:ellipsis; background:#f3f4f6; padding:10px; border-radius:8px; font-size:14px; }
  .qr svg { width: 180px; height: 180px; }
  ul.assets { padding-left: 18px; } ul.assets li { margin: 6px 0; }
  a { color: var(--navy); }
`;

export function PortalLayout({ children, signedIn }: { children: ReactNode; signedIn?: boolean }) {
  return (
    <>
      <style>{PORTAL_CSS}</style>
      <header className="brand">
        <div className="inner">
          <span className="logo">Mambe Fundraisers</span>
          {signedIn && (
            <form method="post" action="/portal/logout">
              <button className="secondary" style={{ padding: "6px 10px", fontSize: 13 }} type="submit">
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>
      <main className="wrap">{children}</main>
    </>
  );
}
