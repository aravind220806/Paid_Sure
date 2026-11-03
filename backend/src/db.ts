import { PrismaClient } from "@prisma/client";

// Single shared Prisma client (hot-reload safe for tsx watch).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Database-level guard for the fingerprint allocator: two PENDING orders of
 * the same merchant may never share an amount. The allocator runs inside a
 * transaction, and this partial unique index catches any race that still slips
 * through (the insert fails, the route re-allocates and retries).
 *
 * SQLite and PostgreSQL both support partial unique indexes; the quoted
 * identifiers match Prisma's generated table/column names.
 */
export async function ensureOrderConstraints(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Order_pending_amount_unique" ` +
      `ON "Order" ("merchantId", "amountPaise") WHERE "status" = 'PENDING'`,
  );
}
