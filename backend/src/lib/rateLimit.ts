/**
 * Small, dependency-free rate limiter (fixed window per key).
 *
 * Free-tier friendly: state lives in-process. If you ever run more than one
 * backend replica, move the same counters to Redis or let the edge
 * (Cloudflare) enforce the coarse limits first.
 */
import type { Request, RequestHandler } from "express";

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowState>();
const concurrent = new Map<string, number>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of buckets) {
    if (state.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref?.();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to the client IP. */
  key?: (req: Request) => string;
  error?: string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  return (req, res, next) => {
    const key = options.key?.(req) ?? `ip:${req.ip ?? "unknown"}`;
    const now = Date.now();
    let state = buckets.get(key);
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, state);
    }
    state.count += 1;
    if (state.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        ok: false,
        error: options.error ?? "rate_limited",
        message:
          options.message ?? "Too many requests. Please retry shortly.",
      });
      return;
    }
    next();
  };
}

/** Rate-limit by bearer token when present, otherwise by IP. */
export function tokenOrIpKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    // Never keep the full secret in memory; a short prefix is enough to key.
    return `tok:${token.slice(0, 12)}`;
  }
  return `ip:${req.ip ?? "unknown"}`;
}

/** Reserve one of `max` concurrent slots for a key (used for SSE streams). */
export function acquireConcurrent(key: string, max: number): boolean {
  const current = concurrent.get(key) ?? 0;
  if (current >= max) return false;
  concurrent.set(key, current + 1);
  return true;
}

export function releaseConcurrent(key: string): void {
  const current = concurrent.get(key) ?? 0;
  if (current <= 1) concurrent.delete(key);
  else concurrent.set(key, current - 1);
}
