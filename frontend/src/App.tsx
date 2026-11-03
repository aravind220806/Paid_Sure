import StatusPage from "./pages/StatusPage";

export default function App() {
  // Hosted checkout/status route: /s/:ref — no router dependency needed.
  const statusRef = window.location.pathname.match(/^\/s\/([A-Za-z0-9-]+)/)?.[1];
  if (statusRef) {
    return <StatusPage refId={statusRef} />;
  }

  return (
    <>
      {/* Sticky nav — one of the few places glass is allowed (layer overlap) */}
      <header className="glass-nav">
        <nav
          className="container"
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            gap: 24,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 17, letterSpacing: "-0.01em" }}>
            PaidSure
          </span>
          <span style={{ color: "var(--text-3)", fontSize: 14 }}>Paid? Sure.</span>
          <span style={{ flex: 1 }} />
          <a href="https://github.com/#" style={{ fontSize: 14, color: "var(--accent-link)" }}>
            Docs
          </a>
          <button className="btn btn--ghost" style={{ minHeight: 36, padding: "0 14px", fontSize: 14 }}>
            Merchant sign in
          </button>
        </nav>
      </header>

      <main className="container" style={{ paddingTop: 64, paddingBottom: 96 }}>
        {/* Hero — one focal statement, whitespace does the work */}
        <section style={{ maxWidth: 620 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "var(--text-2)",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--r-pill)",
              padding: "5px 12px",
              background: "var(--surface)",
            }}
          >
            <span className="live-dot live-dot--pulse" />
            Capture is live — event-driven, no polling
          </div>

          <h1 style={{ fontSize: 48, marginTop: 20 }}>
            Payment confirmation,
            <br />
            with proof.
          </h1>
          <p style={{ color: "var(--text-2)", fontSize: 18, marginTop: 16, lineHeight: 1.85 }}>
            Customers pay your VPA directly — zero fees, zero settlement delay.
            PaidSure confirms from your own payment channels, never from a
            screenshot. Sound-box behavior on the phone you already own.
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
            <button className="btn btn--primary">Open store demo</button>
            <button className="btn btn--ghost">See how it works</button>
          </div>
        </section>

        {/* Demo surface — unified panel + hairline rows (NOT card soup) */}
        <section style={{ marginTop: 72 }}>
          <h2 style={{ fontSize: 22 }}>Today's orders</h2>
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="row">
              <span className="num" style={{ color: "var(--text-3)", fontSize: 14 }}>
                000421
              </span>
              <span className="num" style={{ fontWeight: 600 }}>
                ₹998.37
              </span>
              <span className="chip chip--paid">Paid</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--text-3)", fontSize: 14 }}>
                bank SMS + GPay push · <span className="num">2m</span>
              </span>
            </div>
            <div className="row">
              <span className="num" style={{ color: "var(--text-3)", fontSize: 14 }}>
                000422
              </span>
              <span className="num" style={{ fontWeight: 600 }}>
                ₹149.52
              </span>
              <span className="chip chip--waiting">Waiting</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--text-3)", fontSize: 14 }}>
                expires in <span className="num">6 min</span>
              </span>
            </div>
            <div className="row">
              <span className="num" style={{ color: "var(--text-3)", fontSize: 14 }}>
                000420
              </span>
              <span className="num" style={{ fontWeight: 600 }}>
                ₹79.99
              </span>
              <span className="chip chip--paid">Paid</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "var(--text-3)", fontSize: 14 }}>
                bank email · <span className="num">11m</span>
              </span>
            </div>
          </div>
          <p style={{ color: "var(--text-3)", fontSize: 14, marginTop: 12 }}>
            Every confirmation carries its evidence: raw SMS or push, UTR, and
            the channel that proved it.
          </p>
        </section>
      </main>

      <footer
        style={{
          borderTop: "1px solid var(--hairline)",
          padding: "28px 0",
          color: "var(--text-3)",
          fontSize: 13,
        }}
      >
        <div className="container" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>PaidSure — Paid? Sure.</span>
          <span className="num">MIT license</span>
        </div>
      </footer>
    </>
  );
}
