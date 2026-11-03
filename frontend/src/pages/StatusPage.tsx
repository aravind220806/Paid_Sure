import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Hosted checkout + live status page: /s/:ref
 *
 * - Shows the exact amount, payee and a QR for the UPI intent.
 * - "Open any UPI app" launches the pre-filled intent on the customer's phone.
 * - Live status via SSE (with polling fallback), so the page flips to PAID
 *   the moment the paired phone confirms the money — no refresh needed.
 */

interface OrderView {
  ref: string;
  status: string;
  amountPaise: number;
  payeeName: string;
  storeName: string;
  intentUrl: string | null;
  expiresAt: string | null;
  confirmedSource: string | null;
  paidAt: string | null;
  utr: string | null;
}

function formatINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const SOURCE_LABEL: Record<string, string> = {
  PUSH: "business-app push",
  SMS: "bank SMS",
  EMAIL: "bank email",
  MANUAL: "manual confirm",
};

export default function StatusPage({ refId }: { refId: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  // Initial load
  useEffect(() => {
    let alive = true;
    fetch(`/api/orders/${encodeURIComponent(refId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Order not found" : "Failed to load order");
        const json = await r.json();
        if (alive) setOrder(json.order);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [refId]);

  // Live updates: SSE first, polling as fallback
  useEffect(() => {
    if (!order || order.status !== "PENDING") return;
    let cancelled = false;
    const source = new EventSource(`/api/orders/${encodeURIComponent(refId)}/events`);
    const apply = (json: { status: string; paidAt: string | null }) =>
      setOrder((o) => (o ? { ...o, status: json.status, paidAt: json.paidAt ?? o.paidAt } : o));
    source.addEventListener("status", (e) => {
      try {
        apply(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed frames */
      }
    });
    // Fallback poll in case SSE is buffered/disconnected by a proxy
    const poll = window.setInterval(() => {
      fetch(`/api/orders/${encodeURIComponent(refId)}`)
        .then((r) => r.json())
        .then((json) => json?.order && apply(json.order))
        .catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      source.close();
      void cancelled;
    };
  }, [order?.status, refId]);

  // QR for the intent payload
  useEffect(() => {
    if (!order?.intentUrl) return;
    QRCode.toDataURL(order.intentUrl, {
      margin: 1,
      width: 240,
      color: { dark: "#1d1d1f", light: "#ffffff" },
    })
      .then((dataUrl) => setQr(dataUrl))
      .catch(() => setQr(null));
  }, [order?.intentUrl]);

  const status = order?.status ?? null;
  const isPaid = status === "PAID";
  const isExpired = status === "EXPIRED";
  const isPending = status === "PENDING";

  const minutesLeft = (() => {
    if (!order?.expiresAt) return null;
    const ms = new Date(order.expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 60_000));
  })();

  return (
    <main className="container" style={{ paddingTop: 96, paddingBottom: 96, maxWidth: 480 }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 14, color: "var(--text-3)" }}>{order?.storeName}</div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            fontSize: 13,
            color: "var(--text-2)",
            border: "1px solid var(--hairline)",
            borderRadius: "var(--r-pill)",
            padding: "5px 12px",
            background: "var(--surface)",
          }}
        >
          {status == null ? (
            <>
              <span className="live-dot live-dot--pulse" /> Connecting…
            </>
          ) : isPending ? (
            <>
              <span className="live-dot live-dot--pulse" /> Awaiting payment
            </>
          ) : isPaid ? (
            <>✅ Payment verified</>
          ) : isExpired ? (
            <>⏳ Payment window closed</>
          ) : (
            <>Status: {status}</>
          )}
        </div>
      </div>

      {error != null ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "center", padding: 32 }}>
            <div>
              <div style={{ fontWeight: 600 }}>Order not found</div>
              <div style={{ color: "var(--text-3)", fontSize: 14, marginTop: 6 }}>
                Check the link with the seller.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div
            className="row"
            style={{
              flexDirection: "column",
              gap: 4,
              paddingTop: 32,
              paddingBottom: 24,
              borderTop: "none",
            }}
          >
            <div className="num" style={{ fontSize: 44, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {order ? formatINR(order.amountPaise) : "—"}
            </div>
            <div style={{ color: "var(--text-3)", fontSize: 14 }}>
              to <span style={{ fontWeight: 600 }}>{order?.payeeName}</span>
            </div>
            <div className="num" style={{ color: "var(--text-3)", fontSize: 13 }}>
              Ref {order?.ref}
            </div>
          </div>

          {qr != null ? (
            <div
              className="row"
              style={{ flexDirection: "column", gap: 12, paddingTop: 24, paddingBottom: 24 }}
            >
              <img src={qr} alt="UPI QR code" width={200} height={200} style={{ borderRadius: 12 }} />
              <div style={{ color: "var(--text-3)", fontSize: 13 }}>Scan with any UPI app</div>
            </div>
          ) : (
            <div className="row" style={{ flexDirection: "column", gap: 12, paddingTop: 24, paddingBottom: 24 }}>
              {order?.intentUrl != null ? (
                <a
                  className="btn btn--primary"
                  style={{ textDecoration: "none" }}
                  href={order.intentUrl}
                >
                  Open any UPI app
                </a>
              ) : (
                <span style={{ color: "var(--text-3)", fontSize: 14 }}>Loading checkout…</span>
              )}
              <span style={{ color: "var(--text-3)", fontSize: 13 }}>
                GPay · PhonePe · Paytm — opens pre-filled with the exact amount
              </span>
            </div>
          )}

          <div className="row" style={{ paddingTop: 20, paddingBottom: 20 }}>
            <span style={{ color: "var(--text-3)", fontSize: 14 }}>
              {isPaid && order?.paidAt != null
                ? `Verified via ${SOURCE_LABEL[order.confirmedSource ?? ""] ?? "payment evidence"} · ${new Date(
                    order.paidAt,
                  ).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}${order.utr ? ` · UTR ${order.utr}` : ""}`
                : isExpired
                  ? "Ask the seller for a fresh payment link."
                  : minutesLeft != null
                    ? `Auto-confirmation runs while this stays open · expires in ${minutesLeft} min`
                    : "Live status — the page updates by itself"}
            </span>
            <span style={{ flex: 1 }} />
            {isPaid && <span className="chip chip--paid">Paid</span>}
            {isPending && <span className="chip chip--waiting">Waiting</span>}
          </div>
        </div>
      )}

      <p
        style={{
          textAlign: "center",
          color: "var(--text-3)",
          fontSize: 13,
          marginTop: 20,
          lineHeight: 1.7,
        }}
      >
        Never share card details or OTPs. PaidSure never asks for them —
        payment happens inside your own UPI app.
      </p>
    </main>
  );
}
