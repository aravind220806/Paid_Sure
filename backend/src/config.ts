import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (copy .env.example to .env)"),
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 chars — use a long random value"),
  DEVICE_TOKEN_SECRET: z
    .string()
    .min(16, "DEVICE_TOKEN_SECRET must be at least 16 chars"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 chars"),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .describe("Comma-separated CORS origins. Empty = deny all cross-origin."),
});

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = schema.parse(process.env);

/** Comma-separated allowed CORS origins; empty list = deny all cross-origin. */
export const allowedOrigins: string[] = config.ALLOWED_ORIGINS
  ? config.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];

/**
 * Production safety rail: refuse to boot with dev placeholders or SQLite.
 * (Dev/test boot freely with whatever .env.example provides.)
 */
export function assertNoProductionHazards(cfg: AppConfig): void {
  if (cfg.NODE_ENV !== "production") return;
  if (cfg.DATABASE_URL.startsWith("file:")) {
    throw new Error(
      "[config] file: DATABASE_URL is not allowed in production — point DATABASE_URL at PostgreSQL",
    );
  }
  for (const key of ["JWT_SECRET", "DEVICE_TOKEN_SECRET"] as const) {
    if (cfg[key].startsWith("dev-")) {
      throw new Error(
        `[config] ${key} still holds the dev placeholder — generate a long random value (required in production)`,
      );
    }
  }
  if (cfg.ADMIN_PASSWORD === "dev-admin-password") {
    throw new Error(
      "[config] ADMIN_PASSWORD still holds the dev default — change it (required in production)",
    );
  }
}
assertNoProductionHazards(config);

