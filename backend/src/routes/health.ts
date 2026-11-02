import { Router } from "express";
import { prisma } from "../db.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "paidsure-backend", db: "up" });
  } catch {
    // Service is up but the DB isn't reachable/migrated yet — say so honestly.
    res.status(503).json({ ok: false, service: "paidsure-backend", db: "down" });
  }
});
