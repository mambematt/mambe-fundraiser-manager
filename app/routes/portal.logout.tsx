import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import db from "../db.server";
import { endSession } from "../services/portal.server";
import { clearSessionCookie, readCookie, SESSION_COOKIE } from "../services/portal-http.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await endSession(db, readCookie(request, SESSION_COOKIE));
  return redirect("/portal/login", { headers: { "Set-Cookie": clearSessionCookie() } });
};

export const loader = () => redirect("/portal");
