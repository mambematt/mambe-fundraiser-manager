// Fundraiser statuses and the one list of allowed moves between them.
// Statuses are stored as text; adding one later needs no database change.
// Attribution never looks at status: the window alone decides.

export const STATUSES = [
  "application",
  "setup",
  "scheduled",
  "active",
  "settling",
  "payout_pending",
  "paid",
  "declined",
  "cancelled",
] as const;

export type FundraiserStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<FundraiserStatus, string> = {
  application: "Application",
  setup: "Setup",
  scheduled: "Scheduled",
  active: "Active",
  settling: "Settling",
  payout_pending: "Payout pending",
  paid: "Paid",
  declined: "Declined",
  cancelled: "Cancelled",
};

export type TransitionAction =
  | "approve"
  | "decline"
  | "approve_launch"
  | "back_to_setup"
  | "cancel"
  | "start" // automatic: start time passed
  | "end" // automatic: end time passed
  | "settle" // automatic: settlement re-pull done (settlement step)
  | "record_payment"; // admin: payment recorded (settlement step)

export interface Transition {
  action: TransitionAction;
  from: FundraiserStatus[];
  to: FundraiserStatus;
  /** Who makes the move: an admin click, or the clock. */
  by: "admin" | "clock";
  reasonRequired: boolean;
  label: string;
}

/** THE list of allowed moves. Nothing else may change a fundraiser's status. */
export const TRANSITIONS: readonly Transition[] = [
  { action: "approve", from: ["application"], to: "setup", by: "admin", reasonRequired: false, label: "Approve" },
  { action: "decline", from: ["application", "setup"], to: "declined", by: "admin", reasonRequired: true, label: "Decline" },
  { action: "approve_launch", from: ["setup"], to: "scheduled", by: "admin", reasonRequired: false, label: "Approve launch" },
  // Only before the start date; enforced in canTransition().
  { action: "back_to_setup", from: ["scheduled"], to: "setup", by: "admin", reasonRequired: true, label: "Back to Setup" },
  { action: "cancel", from: ["setup", "scheduled", "active"], to: "cancelled", by: "admin", reasonRequired: true, label: "Cancel fundraiser" },
  { action: "start", from: ["scheduled"], to: "active", by: "clock", reasonRequired: false, label: "Start" },
  { action: "end", from: ["active"], to: "settling", by: "clock", reasonRequired: false, label: "End" },
  { action: "settle", from: ["settling"], to: "payout_pending", by: "clock", reasonRequired: false, label: "Draft payout" },
  { action: "record_payment", from: ["payout_pending"], to: "paid", by: "admin", reasonRequired: false, label: "Record payment" },
];

export function isStatus(value: string): value is FundraiserStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function findTransition(action: TransitionAction): Transition {
  const t = TRANSITIONS.find((x) => x.action === action);
  if (!t) throw new Error(`Unknown action ${action}`);
  return t;
}

export interface TransitionContext {
  now: Date;
  windowStart: Date;
  reason?: string | null;
}

export type TransitionCheck = { ok: true; to: FundraiserStatus } | { ok: false; error: string };

/** Is this move allowed right now? (The launch gate is checked separately.) */
export function canTransition(
  from: string,
  action: TransitionAction,
  ctx: TransitionContext,
): TransitionCheck {
  const t = findTransition(action);
  if (!isStatus(from) || !t.from.includes(from)) {
    return {
      ok: false,
      error: `Can't ${t.label.toLowerCase()} a fundraiser that is ${isStatus(from) ? STATUS_LABELS[from] : from}.`,
    };
  }
  if (t.reasonRequired && !ctx.reason?.trim()) {
    return { ok: false, error: `A reason is required to ${t.label.toLowerCase()}.` };
  }
  if (action === "back_to_setup" && ctx.now.getTime() >= ctx.windowStart.getTime()) {
    return { ok: false, error: "Back to Setup is only allowed before the start date." };
  }
  return { ok: true, to: t.to };
}

/** Admin actions available from a status (for showing buttons). */
export function adminActionsFrom(status: string): Transition[] {
  return TRANSITIONS.filter(
    (t) => t.by === "admin" && isStatus(status) && t.from.includes(status) &&
      // Settlement actions arrive with the settlement step.
      t.action !== "record_payment",
  );
}

/** Dates and rate can be changed until Settling (and never once a payout is frozen). */
export const EDITABLE_DATES_RATE: readonly FundraiserStatus[] = ["application", "setup", "scheduled", "active"];

export function canEditDatesOrRate(status: string): boolean {
  return isStatus(status) && EDITABLE_DATES_RATE.includes(status);
}
