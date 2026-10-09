// Turns audit_log rows into plain sentences for a fundraiser's History.

import { DateTime } from "luxon";
import { STATUS_LABELS, type FundraiserStatus } from "./status";

export interface AuditRow {
  action: string;
  actor: string;
  reason: string | null;
  before: unknown;
  after: unknown;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

function date(v: unknown): string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? DateTime.fromISO(v.slice(0, 10)).toFormat("LLL d") : String(v ?? "—");
}

function money(v: unknown): string {
  return typeof v === "number" ? `$${(v / 100).toFixed(2)}` : "—";
}

function status(v: unknown): string {
  return STATUS_LABELS[v as FundraiserStatus] ?? String(v ?? "—");
}

function who(actor: string): string {
  return actor === "clock" ? "The clock" : actor === "system" ? "The app" : actor;
}

export function describeAudit(row: AuditRow): string {
  const before = obj(row.before);
  const after = obj(row.after);
  const reason = row.reason ? ` Reason: ${row.reason}` : "";
  const actor = who(row.actor);

  if (row.action.startsWith("status:")) {
    return `${actor} moved it from ${status(before.status)} to ${status(after.status)}.${reason}`;
  }
  switch (row.action) {
    case "create":
      return `${actor} created the fundraiser (${date(after.startDate)} – ${date(after.endDate)}, ${money(after.payoutRateCents)} per cape).`;
    case "change_dates_rate": {
      const parts: string[] = [];
      if (before.startDate !== after.startDate) parts.push(`start date ${date(before.startDate)} → ${date(after.startDate)}`);
      if (before.endDate !== after.endDate) parts.push(`end date ${date(before.endDate)} → ${date(after.endDate)}`);
      if (before.payoutRateCents !== after.payoutRateCents) {
        parts.push(`rate ${money(before.payoutRateCents)} → ${money(after.payoutRateCents)}`);
      }
      const units =
        typeof before.qualifyingUnits === "number" ? ` Units ${before.qualifyingUnits} → ${after.qualifyingUnits}.` : "";
      return `${actor} changed ${parts.join(", ") || "dates/rate"}.${units}${reason}`;
    }
    case "checklist:done":
      return `${actor} ticked "${after.item}".`;
    case "checklist:undone":
      return `${actor} unticked "${after.item}".`;
    case "waiting_on_organizer:set":
      return `${actor} marked it waiting on the organizer since ${date(after.since)}.`;
    case "waiting_on_organizer:cleared":
      return `${actor} cleared "waiting on organizer".`;
    case "edit_details": {
      const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      const labels: Record<string, string> = { publicCode: "public code", seasonLabel: "season", paypalPayeeEmail: "PayPal payee", notes: "notes" };
      return `${actor} edited ${changed.map((k) => labels[k] ?? k).join(", ") || "details"}.`;
    }
    case "set_organizers":
      return `${actor} changed the organizers.`;
    case "line_decision":
      return `${actor} chose to ${after.decision} ${after.orderName ?? "a line"} (${after.units ?? "?"} unit${after.units === 1 ? "" : "s"}).${row.reason ? ` Note: ${row.reason}` : ""}`;
    case "asset:add":
      return `${actor} added the ${after.visibility === "organizer" ? "organizer-visible" : "internal"} asset "${after.title}".`;
    case "asset:replace":
      return `${actor} replaced "${before.title}" with "${after.title}".`;
    default:
      return `${actor}: ${row.action}${reason}`;
  }
}
