// Restore drill: check that a restored copy of the database has the money
// records. Reads the restored database's address from RESTORE_DATABASE_URL
// (set it in your own terminal; never paste it into chat or commit it).
// Prints counts only, never personal details.
//
//   PowerShell:
//     $env:RESTORE_DATABASE_URL = "<External Database URL of the restored copy>"
//     node scripts/restore-check.mjs
import { PrismaClient } from "@prisma/client";

const url = process.env.RESTORE_DATABASE_URL;
if (!url) {
  console.error("Set RESTORE_DATABASE_URL first (see the comment at the top of this file).");
  process.exit(1);
}

const db = new PrismaClient({ datasourceUrl: url });
try {
  const [fundraisers, orders, lines, payouts, audit] = await Promise.all([
    db.fundraiser.count(),
    db.shopifyOrder.count(),
    db.orderLineItem.count(),
    db.payout.count(),
    db.auditLog.count(),
  ]);
  console.log("Restored copy contains:");
  console.log(`  fundraisers:  ${fundraisers}`);
  console.log(`  orders:       ${orders}`);
  console.log(`  order lines:  ${lines}`);
  console.log(`  payouts:      ${payouts}`);
  console.log(`  audit entries: ${audit}`);
  const live = await db.fundraiser.findMany({ select: { id: true, publicCode: true, status: true }, orderBy: { id: "asc" } });
  for (const f of live) {
    const qualifying = await db.orderLineItem.aggregate({ where: { attributedFundraiserId: f.id, outcome: "qualifying" }, _sum: { qualifyingUnits: true } });
    console.log(`  ${f.publicCode} (${f.status}): ${qualifying._sum.qualifyingUnits ?? 0} qualifying units`);
  }
  const latest = await db.auditLog.findFirst({ orderBy: { id: "desc" }, select: { createdAt: true } });
  console.log(`  latest audit entry: ${latest?.createdAt.toISOString() ?? "none"}`);
} finally {
  await db.$disconnect();
}
