# PaidSure Alerts — Android helper (Kotlin)

Phase 0 placeholder. The full Gradle/Kotlin scaffold (including the Gradle
wrapper binaries) is set up in Phase 1 — ideally generated once via
Android Studio so the wrapper jar/gradlew land correctly — after which
this folder contains the complete app.

## What it does

Captures **payment evidence** on the merchant's receiving phone and pushes it
to the PaidSure backend:

1. `NotificationListenerService` — reads "payment received" pushes from
   business apps (fast lane, ~1–3 s)
2. `BroadcastReceiver (SMS_RECEIVED)` — reads bank credit SMS (authoritative)
3. Room offline queue + WorkManager — delivery with retry when the network is
   down, batched posting
4. Heartbeat every ~10 min (WorkManager, Doze-friendly; slower in quiet hours)
5. Capture Health UI: status card (fast lane / SMS lanes), alarm sound +
   vibration on failure, one-tap FIX NOW wizard with Android settings
   deep-links, verified by a ₹1 self-test round trip

## Permissions (and WHY — Play-relevant)

| Permission | Purpose |
|---|---|
| `READ_SMS`, `RECEIVE_SMS` | Bank credit SMS capture — the authoritative confirmation lane |
| Notification access (`NOTIFICATION_LISTENER` role) | Business-app "money received" pushes — the instant fast lane |
| `SCHEDULE_EXACT_ALARM` | **Not used** — battery policy forbids exact alarms |
| Battery-optimization exemption | Only for this app's process; keeps capture alive on aggressive OEMs |

## Planned package structure

```
android/app/src/main/java/com/paidsure/alerts/
├── capture/       # NotificationListenerService, SMS receiver, parsers
├── alert/         # alarm sound loop, TTS voice announce, FIX NOW wizard
├── net/           # ingest client, Room queue, heartbeat
├── pair/          # pairing via dashboard QR (device token, stored hashed)
└── ui/            # status card, wizard, detailed status sheet
```

## Backend contract (Phase 1 — implemented)

One doorway, bearer-token auth, batched messages (max 20 per call):

```
POST /api/ingest
Authorization: Bearer psd_…                  # paired device token (stored hashed)
──────────────────────────────────────────────────────────────────────────────
{
  "batteryPct": 88,                          # optional heartbeat fields
  "listenerOn": true,
  "smsOn": true,
  "messages": [
    { "source": "SMS",  "sender": "HDFCBK", "body": "Rs 998.26 credited …", "receivedAt": "2026-11-02T12:00:00Z" },
    { "source": "PUSH", "sender": "gpaybusiness", "body": "You received ₹998.26 …" }
  ]
}
→ { "ok": true, "results": [{ "index": 0, "outcome": "matched", "orderRef": "PS-000421" }] }
```

Outcomes: `matched` · `duplicate` · `ignored` · `unmatched` · `review`
(strict-mode push). The response also carries `matchedOrderRef` so the app can
speak/announce the confirmation immediately.

Pairing (Phase 1 admin bootstrap, dashboard QR in Phase 2):

```
POST /api/admin/merchants/:slug/devices   → { "pairToken": "psd_…" }  (shown once)
```

All over TLS; tokens stored server-side hashed; raw message text stored as
evidence with consent.
