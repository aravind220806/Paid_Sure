/**
 * Outbound webhook delivery with an SSRF guard.
 *
 * Webhook URLs are merchant-supplied, so they are treated as untrusted:
 *  - HTTPS only in production (HTTP + private IPs are dev opt-in)
 *  - hostnames are resolved and private/loopback/link-local ranges rejected
 *  - redirects are never followed (prevents allowlist bypass)
 *  - payloads carry eventId + timestamp and a v2 signature over both
 */
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (/^fe[89ab]/.test(lower)) return true; // link-local
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    }
    return false;
  }
  return true; // unparseable → refuse
}

export async function isSafeWebhookUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.protocol === "http:" && !config.ALLOW_PRIVATE_WEBHOOKS) return false;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return config.ALLOW_PRIVATE_WEBHOOKS || !isPrivateAddress(host);
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every(
      (entry) => config.ALLOW_PRIVATE_WEBHOOKS || !isPrivateAddress(entry.address),
    );
  } catch {
    return false;
  }
}

export async function deliverWebhook(
  rawUrl: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const eventId = randomUUID();
  const body = JSON.stringify({ ...payload, eventId, timestamp });
  const legacy = createHmac("sha256", secret).update(body).digest("hex");
  const v2 = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-paidsure-signature": `sha256=${legacy}`,
    "x-paidsure-signature-v2": `sha256=${v2}`,
    "x-paidsure-timestamp": timestamp,
    "x-paidsure-event-id": eventId,
  };
  await send(rawUrl, body, headers, 0);
}

async function send(
  url: string,
  body: string,
  headers: Record<string, string>,
  attempt: number,
): Promise<void> {
  // Re-check on every attempt so a DNS change cannot turn a safe host private.
  if (!(await isSafeWebhookUrl(url))) {
    console.warn("[paidsure] webhook blocked: unsafe URL");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300 && res.status < 400) {
      console.warn("[paidsure] webhook redirect refused", res.status);
      return;
    }
    if (res.status >= 500 && attempt < 2) {
      scheduleRetry(url, body, headers, attempt);
      return;
    }
    if (!res.ok) console.warn("[paidsure] webhook rejected", res.status);
  } catch (e) {
    if (attempt < 2) {
      scheduleRetry(url, body, headers, attempt);
      return;
    }
    console.warn("[paidsure] webhook delivery failed", (e as Error)?.message);
  }
}

function scheduleRetry(
  url: string,
  body: string,
  headers: Record<string, string>,
  attempt: number,
): void {
  const timer = setTimeout(
    () => void send(url, body, headers, attempt + 1),
    500 * (attempt + 1),
  );
  timer.unref?.();
}
