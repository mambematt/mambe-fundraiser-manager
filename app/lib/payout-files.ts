// Files for paying and for the accountant. Pure.

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const money = (cents: number) => (cents / 100).toFixed(2);

export interface PaypalRow {
  payeeEmail: string;
  amountCents: number;
  publicCode: string;
}

/**
 * PayPal Payouts web upload (Business Tools → Make Payments → Payouts):
 * no header row; columns: recipient, amount, currency, reference ID (≤30,
 * no spaces), note to recipient (≤400), recipient wallet. One currency per
 * file. Mambe pays any PayPal fee, so the amount is the full payout.
 */
export function paypalPayoutsCsv(rows: PaypalRow[]): string {
  return toCsv(
    rows.map((r) => {
      const reference = r.publicCode.replace(/\s+/g, "").slice(0, 30);
      const note = `Mambe fundraiser payout ${r.publicCode}`.slice(0, 400);
      return [r.payeeEmail, money(r.amountCents), "USD", reference, note, "PAYPAL"];
    }),
  );
}

export function paypalTotalCents(rows: PaypalRow[]): number {
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}

export interface AccountantRow {
  publicCode: string;
  organization: string;
  team: string;
  payeeEmail: string | null;
  units: number;
  rateCents: number;
  calculatedCents: number;
  adjustmentsCents: number;
  finalCents: number;
  status: string;
  approvedDate: string | null;
  paidDate: string | null;
  paidAmountCents: number | null;
  paypalReference: string | null;
}

export function accountantCsv(rows: AccountantRow[]): string {
  return toCsv([
    ["Fundraiser", "Organization", "Team", "Payee email", "Units", "Rate", "Calculated", "Adjustments", "Final", "Status", "Approved date", "Paid date", "Amount paid", "PayPal reference"],
    ...rows.map((r) => [
      r.publicCode,
      r.organization,
      r.team,
      r.payeeEmail ?? "",
      r.units,
      money(r.rateCents),
      money(r.calculatedCents),
      money(r.adjustmentsCents),
      money(r.finalCents),
      r.status,
      r.approvedDate ?? "",
      r.paidDate ?? "",
      r.paidAmountCents === null ? "" : money(r.paidAmountCents),
      r.paypalReference ?? "",
    ]),
  ]);
}
