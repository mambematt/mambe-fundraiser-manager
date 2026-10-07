import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  entity: string;
  entityId: string | number;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  actor: string;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Appends to audit_log. The table refuses updates and deletes. */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      entity: entry.entity,
      entityId: String(entry.entityId),
      action: entry.action,
      before: toJson(entry.before),
      after: toJson(entry.after),
      reason: entry.reason ?? null,
      actor: entry.actor,
    },
  });
}
