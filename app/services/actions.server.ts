// Shared handling for admin form actions: expected problems become a banner
// message; anything unexpected is alerted and shown generically.
import { UserError } from "../lib/errors";
import { alertError } from "./alerts.server";

export interface ActionResult {
  ok: boolean;
  message: string;
  warnings?: string[];
  [key: string]: unknown;
}

export async function attempt(work: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof UserError) return { ok: false, message: error.message };
    alertError(error, "Admin action failed");
    return { ok: false, message: "Something went wrong. It has been logged; please try again or tell Claude." };
  }
}

export function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function formInt(form: FormData, key: string): number | null {
  const n = Number(formText(form, key));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** "$25" or "25.00" → 2500 cents. */
export function formDollarsToCents(form: FormData, key: string): number | null {
  const text = formText(form, key).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}
