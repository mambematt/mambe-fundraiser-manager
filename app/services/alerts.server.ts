// Alerts for failures that must not go unnoticed. Logged always; also sent
// to Sentry (which emails the team) when SENTRY_DSN is set.

import * as Sentry from "@sentry/node";

let initialized = false;

function sentryEnabled(): boolean {
  if (!process.env.SENTRY_DSN) return false;
  if (!initialized) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.RENDER_SERVICE_NAME ?? process.env.NODE_ENV ?? "development",
      tracesSampleRate: 0,
    });
    initialized = true;
  }
  return true;
}

export function alert(message: string, extra?: Record<string, unknown>): void {
  console.error(`[ALERT] ${message}`, extra ?? "");
  if (sentryEnabled()) Sentry.captureMessage(message, { level: "error", extra });
}

export function alertError(error: unknown, message: string, extra?: Record<string, unknown>): void {
  console.error(`[ALERT] ${message}`, error, extra ?? "");
  if (sentryEnabled()) Sentry.captureException(error, { extra: { message, ...extra } });
}

/** Wait for queued alerts to be sent (before a job's response returns). */
export async function flushAlerts(): Promise<void> {
  if (initialized) await Sentry.flush(3000);
}
