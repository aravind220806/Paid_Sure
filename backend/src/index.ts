import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { allowedOrigins, config } from "./config.js";
import { ensureOrderConstraints } from "./db.js";
import { healthRouter } from "./routes/health.js";
import { ordersRouter } from "./routes/orders.js";
import { ingestRouter } from "./routes/ingest.js";
import { adminRouter } from "./routes/admin.js";
import { startOrderSweeper, sweepExpiredOrders } from "./services/orderSweeper.js";
import { rateLimit } from "./lib/rateLimit.js";

const app: Express = express();

app.disable("x-powered-by");
if (config.TRUST_PROXY > 0) app.set("trust proxy", config.TRUST_PROXY);

// Minimal security header set — APIs serve JSON only, no CSP needed here yet.
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (config.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// CORS: explicit allowlist only. Empty ALLOWED_ORIGINS (dev default) denies
// every cross-origin request — the Vite dev proxy is same-origin, so local
// frontend work needs no CORS entry.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false); // silently withhold ACAO → browser blocks
    },
  }),
);

app.use(express.json({ limit: "256kb" }));

app.use(healthRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/ingest", ingestRouter);
app.use(
  "/api/admin",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    key: (req) => `admin:${req.ip ?? "unknown"}`,
    error: "admin_rate_limited",
  }),
  adminRouter,
);

// Unknown routes → clean JSON 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

// Central error handler (keep the shape; extend in Phase 1 with problem codes)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[paidsure] unhandled error:", err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

async function bootstrap(): Promise<void> {
  await ensureOrderConstraints();
  await sweepExpiredOrders().catch((error) => {
    console.error("[paidsure] initial order sweep failed", error);
  });
  startOrderSweeper();
  app.listen(config.PORT, () => {
    console.log(
      `[paidsure] backend up on http://localhost:${config.PORT} (${config.NODE_ENV})`,
    );
    console.log("[paidsure] fingerprint safeguards active (index, sweeper)");
  });
}

bootstrap().catch((error) => {
  console.error("[paidsure] startup safeguard failed", error);
  process.exit(1);
});
