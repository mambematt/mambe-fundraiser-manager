// Money is integer cents everywhere. Shopify sends decimal strings ("195.00");
// convert without ever going through floating point.

export function decimalToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a decimal amount: ${text}`);
  const [, minus, whole, fraction = ""] = match;
  // Round half up on the third decimal place, if any.
  const padded = (fraction + "000").slice(0, 3);
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return minus ? -cents : cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
