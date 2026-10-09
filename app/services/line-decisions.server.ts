// Admin include/exclude decisions on flagged lines (spec rule 6, case 11).

import type { PrismaClient } from "@prisma/client";
import { netUnits } from "../lib/attribution";
import { UserError } from "../lib/errors";
import { attributeSavedOrder } from "./order-sync.server";
import { writeAudit } from "./audit.server";
import { storedTotals } from "./fundraisers.server";

export type Decision = "include" | "exclude";

/** Decisions are possible until the payout is frozen. */
export async function decisionsLockedReason(db: PrismaClient, fundraiserId: number): Promise<string | null> {
  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId }, include: { payout: true } });
  if (f.status === "paid") return "This fundraiser is paid; its lines are final.";
  if (f.payout && f.payout.status !== "draft") return "The payout is frozen; line decisions are locked.";
  return null;
}

export async function decideLine(
  db: PrismaClient,
  lineId: number,
  decision: Decision,
  note: string,
  actor: string,
) {
  if (decision !== "include" && decision !== "exclude") throw new UserError("Choose include or exclude.");
  if (!note.trim()) throw new UserError("A note is required to include or exclude a line.");

  const line = await db.orderLineItem.findUniqueOrThrow({ where: { id: lineId }, include: { order: true } });
  if (!line.attributedFundraiserId) throw new UserError("This line isn't part of a fundraiser.");
  if (line.reviewFlags.length === 0) throw new UserError("Only flagged lines need a decision.");
  if (line.locked) throw new UserError("This line is locked in a frozen payout.");
  const locked = await decisionsLockedReason(db, line.attributedFundraiserId);
  if (locked) throw new UserError(locked);

  const fundraiserId = line.attributedFundraiserId;
  await db.$transaction(async (tx) => {
    await tx.orderLineItem.update({
      where: { id: lineId },
      data: { adminDecision: decision, adminDecisionNote: note.trim(), adminDecisionBy: actor, adminDecisionAt: new Date() },
    });
    await attributeSavedOrder(tx, line.orderId);
    const after = await tx.orderLineItem.findUniqueOrThrow({ where: { id: lineId } });
    await writeAudit(tx, {
      entity: "fundraiser",
      entityId: fundraiserId,
      action: "line_decision",
      before: { lineId, decision: line.adminDecision, note: line.adminDecisionNote, qualifyingUnits: line.qualifyingUnits },
      after: {
        lineId,
        orderName: line.order.name,
        decision,
        flags: line.reviewFlags,
        units: netUnits(line),
        qualifyingUnits: after.qualifyingUnits,
      },
      reason: note.trim(),
      actor,
    });
  });

  const f = await db.fundraiser.findUniqueOrThrow({ where: { id: fundraiserId } });
  return storedTotals(db, f);
}
