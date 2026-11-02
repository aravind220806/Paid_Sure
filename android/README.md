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
| Notification access ( aranee `NOTIFICATION_LISTENER` role) | Business-app "money received" pushes — the instant fast lane |
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

## Backend contract (Phase 1 implements these endpoints)

- `POST /api/ingest/sms` — `{ token, messages: [{ sender, body, receivedAt }] }`
- `POST /api/ingest/push` — `{ token, notifications: [{ package, title, text, at }] }`
- `POST /api/device/heartbeat` — `{ token, batteryPct, listenerOn, smsOn, queued }`
- `POST /api/device/pair` — dashboard-issued pairing code → device token (hashed

All over TLS; tokens stored server-side hashed; raw message text stored as
evidence with consent.
