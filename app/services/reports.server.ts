// V1 reports (spec "V1 reports"): fixed tables, each with a CSV. Every count
// comes from the stored, attributed lines (the attribution engine's output) or
// from frozen payouts; nothing here re-counts units its own way.

import type { PrismaClient } from "@prisma/client";
import { netUnits } from "../lib/attribution";
import { toCsv } from "../lib/payout-files";
import { STATUS_LABELS, STATUSES, type FundraiserStatus } from "../lib/status";
import { isoDate, storedTotals } from "./fundraisers.server";
import { lifetimeTotalsForProduct } from "./products.server";
import { payoutSummary } from "./settlement.server";

export type Cell = string | number | null;
export type ColumnKind = "text" | "number" | "money";

export interface ReportTable {
  key: string;
  title: string;
  note?: string;
  columns: Array<{ label: string; kind: ColumnKind }>;
  rows: Cell[][];
  /** A final totals row, when the table has one. */
  totals?: Cell[];
}

const text = (label: string) => ({ label, kind: "text" as const });
const num = (label: string) => ({ label, kind: "number" as const });
const money = (label: string) => ({ label, kind: "money" as const });

/** Money cells are cents; the CSV writes dollars. */
export function reportCsv(table: ReportTable): string {
  const cell = (value: Cell, i: number) =>
    value === null ? "" : table.columns[i]?.kind === "money" && typeof value === "number" ? (value / 100).toFixed(2) : value;
  return toCsv([
    table.columns.map((c) => c.label),
    ...table.rows.map((r) => r.map(cell)),
    ...(table.totals ? [table.totals.map(cell)] : []),
  ]);
}

interface FundraiserNumbers {
  id: number;
  publicCode: string;
  status: string;
  organizationId: number;
  organization: string;
  teamId: number;
  team: string;
  units: number;
  raisedCents: number;
  final: boolean;
}

/** Units and $ per fundraiser: frozen payout numbers once approved or paid, else the live estimate. */
async function fundraiserNumbers(db: PrismaClient): Promise<FundraiserNumbers[]> {
  const fundraisers = await db.fundraiser.findMany({
    where: { status: { not: "declined" } },
    include: { team: { include: { organization: true } }, payout: true },
    orderBy: [{ windowStart: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  });
  return Promise.all(
    fundraisers.map(async (f) => {
      const frozen = f.payout && f.payout.status !== "draft";
      const live = frozen ? null : await storedTotals(db, f);
      return {
        id: f.id,
        publicCode: f.publicCode,
        status: f.status,
        organizationId: f.team.organizationId,
        organization: f.team.organization.name,
        teamId: f.teamId,
        team: f.team.name,
        units: frozen ? f.payout!.qualifyingUnits : live!.qualifyingUnits,
        raisedCents: frozen ? (f.payout!.finalCents ?? f.payout!.amountCents) : live!.estimatedPayoutCents,
        final: !!frozen,
      };
    }),
  );
}

function groupSum<T>(items: FundraiserNumbers[], key: (f: FundraiserNumbers) => T) {
  const map = new Map<T, { first: FundraiserNumbers; fundraisers: number; units: number; raisedCents: number }>();
  for (const f of items) {
    const g = map.get(key(f)) ?? { first: f, fundraisers: 0, units: 0, raisedCents: 0 };
    g.fundraisers += 1;
    g.units += f.units;
    g.raisedCents += f.raisedCents;
    map.set(key(f), g);
  }
  return [...map.values()];
}

export async function buildReports(db: PrismaClient, now = new Date()): Promise<ReportTable[]> {
  const tables: ReportTable[] = [];

  // 1. Fundraisers by status.
  const byStatus = await db.fundraiser.groupBy({ by: ["status"], _count: true });
  const statusCount = new Map(byStatus.map((s) => [s.status, s._count]));
  tables.push({
    key: "by-status",
    title: "Fundraisers by status",
    columns: [text("Status"), num("Fundraisers")],
    rows: STATUSES.filter((s) => s !== "application" || statusCount.has(s)).map((s) => [STATUS_LABELS[s], statusCount.get(s) ?? 0]),
    totals: ["Total", byStatus.reduce((sum, s) => sum + s._count, 0)],
  });

  // 2. Qualifying units and $ raised: by fundraiser, team, organization.
  const numbers = await fundraiserNumbers(db);
  const sumUnits = numbers.reduce((s, f) => s + f.units, 0);
  const sumRaised = numbers.reduce((s, f) => s + f.raisedCents, 0);
  tables.push({
    key: "raised-by-fundraiser",
    title: "Qualifying units and $ raised, by fundraiser",
    note: "Final once the payout is approved; estimated before that. Declined fundraisers are left out.",
    columns: [text("Fundraiser"), text("Organization"), text("Team"), text("Status"), num("Qualifying units"), money("Raised"), text("Basis")],
    rows: numbers.map((f) => [f.publicCode, f.organization, f.team, STATUS_LABELS[f.status as FundraiserStatus] ?? f.status, f.units, f.raisedCents, f.final ? "final" : "estimated"]),
    totals: ["Total", null, null, null, sumUnits, sumRaised, null],
  });
  tables.push({
    key: "raised-by-team",
    title: "Qualifying units and $ raised, by team",
    columns: [text("Team"), text("Organization"), num("Fundraisers"), num("Qualifying units"), money("Raised")],
    rows: groupSum(numbers, (f) => f.teamId).map((g) => [g.first.team, g.first.organization, g.fundraisers, g.units, g.raisedCents]),
    totals: ["Total", null, numbers.length, sumUnits, sumRaised],
  });
  tables.push({
    key: "raised-by-organization",
    title: "Qualifying units and $ raised, by organization",
    columns: [text("Organization"), num("Fundraisers"), num("Qualifying units"), money("Raised")],
    rows: groupSum(numbers, (f) => f.organizationId).map((g) => [g.first.organization, g.fundraisers, g.units, g.raisedCents]),
    totals: ["Total", numbers.length, sumUnits, sumRaised],
  });

  // 3. Payouts: paid vs outstanding.
  const payouts = await db.payout.findMany();
  const payoutRows = new Map<string, { count: number; cents: number }>();
  for (const p of payouts) {
    const cents = p.status === "paid" ? (p.paidAmountCents ?? p.finalCents ?? 0) : p.status === "approved" ? (p.finalCents ?? 0) : (await payoutSummary(db, p.id)).finalCents;
    const row = payoutRows.get(p.status) ?? { count: 0, cents: 0 };
    row.count += 1;
    row.cents += cents;
    payoutRows.set(p.status, row);
  }
  const get = (s: string) => payoutRows.get(s) ?? { count: 0, cents: 0 };
  const outstanding = { count: get("draft").count + get("approved").count, cents: get("draft").cents + get("approved").cents };
  tables.push({
    key: "payouts",
    title: "Payouts: paid vs outstanding",
    note: "Drafts are still estimated. Paid uses the amount actually sent.",
    columns: [text("Payouts"), num("Count"), money("Amount")],
    rows: [
      ["Draft (to review)", get("draft").count, get("draft").cents],
      ["Approved, not paid", get("approved").count, get("approved").cents],
      ["Outstanding (draft + approved)", outstanding.count, outstanding.cents],
      ["Paid", get("paid").count, get("paid").cents],
    ],
    totals: ["All payouts", payouts.length, outstanding.cents + get("paid").cents],
  });

  // 4. Per product: lifetime units and revenue, in-window vs outside-window.
  const products = await db.product.findMany({ orderBy: { title: "asc" } });
  const productRows: Cell[][] = [];
  const pt = { inU: 0, inR: 0, outU: 0, outR: 0 };
  for (const p of products) {
    const t = await lifetimeTotalsForProduct(db, p.shopifyProductId);
    productRows.push([p.title, p.status, t.netUnits, t.inWindowUnits, t.inWindowRevenueCents, t.outsideWindowUnits, t.outsideWindowRevenueCents]);
    pt.inU += t.inWindowUnits;
    pt.inR += t.inWindowRevenueCents;
    pt.outU += t.outsideWindowUnits;
    pt.outR += t.outsideWindowRevenueCents;
  }
  tables.push({
    key: "products",
    title: "Per product: lifetime units and revenue",
    note: "Line price × units, test orders left out. In-window = qualifying units; outside = sales outside any fundraiser window.",
    columns: [text("Product"), text("Shopify status"), num("Net units"), num("In-window units"), money("In-window revenue"), num("Outside-window units"), money("Outside-window revenue")],
    rows: productRows,
    totals: ["Total", null, productRows.reduce((s, r) => s + (r[2] as number), 0), pt.inU, pt.inR, pt.outU, pt.outR],
  });

  // 5. Repeat rate: teams with more than one fundraiser, out of all teams with one.
  const perTeam = groupSum(numbers, (f) => f.teamId);
  const repeat = perTeam.filter((g) => g.fundraisers > 1);
  const rate = perTeam.length ? Math.round((repeat.length / perTeam.length) * 1000) / 10 : 0;
  tables.push({
    key: "repeat-rate",
    title: "Repeat rate",
    note: `${repeat.length} of ${perTeam.length} teams with a fundraiser have run more than one (${rate}%). Declined fundraisers don't count.`,
    columns: [text("Team"), text("Organization"), num("Fundraisers")],
    rows: perTeam.sort((a, b) => b.fundraisers - a.fundraisers || a.first.team.localeCompare(b.first.team)).map((g) => [g.first.team, g.first.organization, g.fundraisers]),
    totals: [`Repeat teams: ${repeat.length} of ${perTeam.length}`, null, `${rate}%`],
  });

  // 6. Sales after a team's first fundraiser ended.
  const teams = await db.team.findMany({
    include: {
      organization: true,
      products: { select: { shopifyProductId: true } },
      fundraisers: { where: { status: { not: "declined" }, windowStart: { not: null } }, include: { product: { select: { shopifyProductId: true } } }, orderBy: { windowStart: "asc" } },
    },
    orderBy: { name: "asc" },
  });
  const afterRows: Cell[][] = [];
  const at = { units: 0, revenue: 0, later: 0, outside: 0 };
  for (const team of teams) {
    const first = team.fundraisers[0];
    if (!first?.windowEnd) continue;
    const ended = first.cancelledAt && first.cancelledAt < first.windowEnd ? first.cancelledAt : first.windowEnd;
    if (ended > now) continue;
    const productIds = [...new Set([...team.products.map((p) => p.shopifyProductId), ...team.fundraisers.map((f) => f.product?.shopifyProductId).filter((x): x is string => !!x)])];
    const lines = await db.orderLineItem.findMany({
      where: { shopifyProductId: { in: productIds }, order: { processedAt: { gte: ended }, isTest: false } },
      include: { order: { select: { cancelledAt: true } } },
    });
    let units = 0;
    let revenue = 0;
    let later = 0;
    let outside = 0;
    for (const l of lines) {
      const n = l.outcome === "qualifying" ? l.qualifyingUnits : l.order.cancelledAt ? 0 : netUnits(l);
      units += n;
      revenue += n * l.unitPriceCents;
      if (l.outcome === "qualifying") later += n;
      else outside += n;
    }
    afterRows.push([team.name, team.organization.name, first.publicCode, isoDate(ended), units, revenue, later, outside]);
    at.units += units;
    at.revenue += revenue;
    at.later += later;
    at.outside += outside;
  }
  tables.push({
    key: "after-first",
    title: "Sales after a team's first fundraiser ended",
    note: "The team's products, from the moment its first fundraiser ended (or was cancelled). Test orders left out.",
    columns: [text("Team"), text("Organization"), text("First fundraiser"), text("Ended (UTC date)"), num("Units since"), money("Revenue since"), num("In later fundraisers"), num("Outside any fundraiser")],
    rows: afterRows,
    totals: ["Total", null, null, null, at.units, at.revenue, at.later, at.outside],
  });

  return tables;
}
