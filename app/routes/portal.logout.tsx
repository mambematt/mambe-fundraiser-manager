import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import db from "../db.server";
import { endSession } from "../services/portal.server";
import { clearSessionCookie, readCookies, SESSION_COOKIE } from "../services/portal-http.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  for (const raw of readCookies(request, SESSION_COOKIE)) await endSession(db, raw);
  return redirect("/portal/login", { headers: { "Set-Cookie": clearSessionCookie() } });
};

export const loader = () => redirect("/portal");
