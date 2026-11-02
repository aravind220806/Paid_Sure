import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { config } from "./config.js";
import { healthRouter } from "./routes/health.js";

const app: Express = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.use(healthRouter);

// Unknown routes → clean JSON 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

// Central error handler (keep the shape; extend in Phase 1 with problem codes)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[paidsure] unhandled error:", err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

app.listen(config.PORT, () => {
  console.log(
    `[paidsure] backend up on http://localhost:${config.PORT} (${config.NODE_ENV})`,
  );
});
