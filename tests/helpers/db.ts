import { PrismaClient } from "@prisma/client";
import { inject } from "vitest";
import { computeWindow } from "../../app/lib/window";

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  client ??= new PrismaClient({ datasourceUrl: inject("databaseUrl") });
  return client;
}

/** Empties every table. audit_log's no-truncate guard is lifted only here. */
export async function resetDb() {
  const db = testDb();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_no_truncate"`);
  try {
    await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_no_truncate"`);
  }
}

export async function seedTeamAndProduct(shopifyProductId = "1001") {
  const db = testDb();
  const org = await db.organization.create({ data: { name: "Central High School", type: "school" } });
  const team = await db.team.create({ data: { organizationId: org.id, name: "Girls Lacrosse" } });
  const product = await db.product.create({
    data: {
      shopifyProductId,
      handle: "central-high-girls-lacrosse-cape",
      title: "Central High Girls Lacrosse Cape",
      status: "ACTIVE",
      tags: ["fundraiser"],
      teamId: team.id,
    },
  });
  return { org, team, product };
}

/** Test-only fundraiser insert. The real create/edit service arrives in session 2. */
export async function insertFundraiser(args: {
  publicCode: string;
  teamId: number;
  productId: number;
  startDate: string;
  endDate: string;
  status?: string;
  cancelledAt?: Date;
}) {
  const window = computeWindow(args.startDate, args.endDate);
  return testDb().fundraiser.create({
    data: {
      publicCode: args.publicCode,
      teamId: args.teamId,
      productId: args.productId,
      startDate: new Date(`${args.startDate}T00:00:00Z`),
      endDate: new Date(`${args.endDate}T00:00:00Z`),
      windowStart: window.start,
      windowEnd: window.end,
      status: args.status ?? "active",
      cancelledAt: args.cancelledAt ?? null,
    },
  });
}
