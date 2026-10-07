// Render's health check: the app is up and can reach the database.
import db from "../db.server";

export const loader = async () => {
  await db.$queryRaw`SELECT 1`;
  return new Response("ok", { headers: { "Content-Type": "text/plain" } });
};
