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
});

export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = schema.parse(process.env);
