// Klaviyo: the app decides who gets which email and when; Klaviyo flows (one
// per metric) format and send it. Organizers are added to the "Fundraiser
// Organizers" list without being subscribed to marketing.
//
// Staging safety: when KLAVIYO_TEST_RECIPIENT is set, every event goes to
// that address instead of the organizer's.

export const METRICS = {
  loginLink: "Portal Login Link",
  launched: "Fundraiser Launched",
  reminder: "Fundraiser Reminder",
  finalDays: "Fundraiser Final Days",
  ended: "Fundraiser Ended",
  payoutSent: "Payout Sent",
  portalReady: "Fundraiser Portal Ready",
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

export interface Recipient {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface KlaviyoClient {
  /** Sends one event to one person. `uniqueId` stops Klaviyo double-counting a retried send. */
  sendEvent(metric: MetricName, to: Recipient, properties: Record<string, unknown>, uniqueId: string): Promise<{ deliveredTo: string }>;
}

const API = "https://a.klaviyo.com/api";
const REVISION = "2026-07-15";

function headers(key: string) {
  return {
    Authorization: `Klaviyo-API-Key ${key}`,
    revision: REVISION,
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
  };
}

async function call(key: string, path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: headers(key), body: JSON.stringify(body) });
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => "");
    throw new Error(`Klaviyo ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res;
}

export function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function createKlaviyoClient(env: NodeJS.ProcessEnv = process.env): KlaviyoClient {
  return {
    async sendEvent(metric, to, properties, uniqueId) {
      const key = env.KLAVIYO_API_KEY;
      if (!key) throw new Error("KLAVIYO_API_KEY isn't set on this service.");
      const testRecipient = env.KLAVIYO_TEST_RECIPIENT?.trim();
      const email = testRecipient || to.email;

      // Create or update the profile, then put it on the organizers list
      // (list membership is not marketing consent).
      const profileRes = await call(key, "/profile-import", {
        data: {
          type: "profile",
          attributes: {
            email,
            first_name: testRecipient ? `TEST (${to.firstName ?? ""})` : (to.firstName ?? undefined),
            last_name: testRecipient ? undefined : (to.lastName ?? undefined),
          },
        },
      });
      const profile = (await profileRes.json().catch(() => null)) as { data?: { id?: string } } | null;
      const listId = env.KLAVIYO_ORGANIZER_LIST_ID;
      if (listId && profile?.data?.id) {
        await call(key, `/lists/${listId}/relationships/profiles`, { data: [{ type: "profile", id: profile.data.id }] });
      }

      await call(key, "/events", {
        data: {
          type: "event",
          attributes: {
            properties: testRecipient ? { ...properties, intended_recipient: to.email } : properties,
            unique_id: uniqueId,
            metric: { data: { type: "metric", attributes: { name: metric } } },
            profile: { data: { type: "profile", attributes: { email } } },
          },
        },
      });
      return { deliveredTo: email };
    },
  };
}
