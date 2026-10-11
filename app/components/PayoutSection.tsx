import { Form } from "react-router";
import { dollars, pacific } from "../lib/format";
import type { PayoutView } from "../services/payout-view.server";
import { CsvDownload } from "./CsvDownload";

const STATUS: Record<string, string> = { draft: "Draft (estimated, still updating)", approved: "Approved (frozen)", paid: "Paid (final)" };

function Money({ cents }: { cents: number }) {
  return <>{dollars(cents)}</>;
}

export function PayoutSection({ view, publicCode, busy, dryRun }: { view: PayoutView; publicCode: string; busy: boolean; dryRun?: { ordersRead: number; units: number; amountCents: number; unresolvedFlags: number } | null }) {
  const p = view.payout;
  return (
    <div id="payout">
      <s-section heading="Payout">
        <s-stack gap="base">
          {view.settlementError && (
            <s-banner tone="critical">
              <s-paragraph>
                {view.settlementError}. No payout is calculated until the re-pull succeeds; the clock retries every 15 minutes.
              </s-paragraph>
            </s-banner>
          )}

          {!p && (
            <s-stack gap="small">
              <s-paragraph>
                Settles automatically on <s-text type="strong">{pacific(view.dueAt)}</s-text> (10 days after the end): a full
                re-check against Shopify, then a draft payout for your review.
              </s-paragraph>
              {view.canDryRun && (
                <Form method="post">
                  <input type="hidden" name="intent" value="dryRun" />
                  <s-button type="submit" disabled={busy}>Dry-run settlement now</s-button>
                </Form>
              )}
              {dryRun && (
                <s-banner tone="info">
                  <s-paragraph>
                    Dry run (nothing saved to the payout): re-checked {dryRun.ordersRead} orders with Shopify. Today the draft would
                    be <s-text type="strong">{dryRun.units} units, {dollars(dryRun.amountCents)}</s-text>
                    {dryRun.unresolvedFlags ? `, with ${dryRun.unresolvedFlags} flagged line(s) to resolve` : ""}.
                  </s-paragraph>
                </s-banner>
              )}
            </s-stack>
          )}

          {p && (
            <>
              <s-paragraph>
                <s-badge tone={p.status === "paid" ? "success" : p.status === "approved" ? "info" : "warning"}>{STATUS[p.status] ?? p.status}</s-badge>{" "}
                Re-checked with Shopify {pacific(view.repulledAt)} ({view.repullOrders ?? 0} orders).
              </s-paragraph>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
                {[
                  ["Units", String(p.units)],
                  ["Rate", dollars(p.rateCents)],
                  ["Calculated", dollars(p.amountCents)],
                  ["Adjustments", dollars(p.adjustmentsCents)],
                  ["Final amount", dollars(p.finalCents)],
                ].map(([label, value]) => (
                  <s-box key={label} padding="base" borderWidth="base" borderRadius="base">
                    <s-text color="subdued">{label}</s-text>
                    <s-heading>{value}</s-heading>
                  </s-box>
                ))}
              </s-grid>
              <s-paragraph>
                Payee: {p.payeeEmail ?? "not set"}. Mambe pays any PayPal fee; the organization receives the full final amount.
              </s-paragraph>

              {p.adjustments.length > 0 && (
                <s-stack gap="small">
                  <s-heading>Adjustments</s-heading>
                  {p.adjustments.map((a) => (
                    <s-paragraph key={a.id}>
                      <Money cents={a.amountCents} /> · {a.date} · {a.reason} · {a.note} <s-text color="subdued">({a.by})</s-text>
                    </s-paragraph>
                  ))}
                </s-stack>
              )}

              {p.status === "draft" && (
                <>
                  <Form method="post">
                    <input type="hidden" name="intent" value="adjust" />
                    <s-stack gap="small">
                      <s-heading>Add an adjustment</s-heading>
                      <s-stack direction="inline" gap="base" alignItems="end">
                        <s-text-field name="amount" label="Amount ($, use - to reduce)" placeholder="-25.00" required />
                        <s-date-field name="date" label="Date" required />
                        <s-text-field name="reason" label="Reason" required />
                        <s-text-field name="note" label="Note" required />
                        <s-button type="submit" disabled={busy}>Add</s-button>
                      </s-stack>
                    </s-stack>
                  </Form>

                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack gap="small">
                      <s-heading>
                        Shopify cross-check {p.crosscheckRequired ? "(required: one of the first 3 payouts)" : "(optional)"}
                      </s-heading>
                      {view.crosscheck && (
                        <>
                          <s-paragraph>
                            Store timezone: {view.crosscheck.storeTimezone}. In store time the window is {view.crosscheck.windowInStoreTime}.
                            {view.crosscheck.sameZone ? " That's the same timezone as the fundraiser, so a date-range report lines up." : " That differs from the fundraiser's timezone, so check the edge orders below."}
                          </s-paragraph>
                          <s-paragraph>
                            In Shopify: Analytics → Reports → Sales by product. Date range {view.crosscheck.reportStartDate} to{" "}
                            {view.crosscheck.reportEndDate}. Filter Product title = {view.crosscheck.productTitle}. Read Net items sold (test
                            orders are excluded by Shopify). The app counts {view.crosscheck.units} units on {view.crosscheck.orders} orders.
                          </s-paragraph>
                          {view.crosscheck.edgeOrders.length > 0 && (
                            <s-stack gap="small">
                              <s-text type="strong">Orders within 24 hours of the window edges</s-text>
                              {view.crosscheck.edgeOrders.map((e) => (
                                <s-paragraph key={e.orderName + e.checkoutPacific}>
                                  {e.orderName} · {e.side === "inside" ? "inside" : "outside"} · store time {e.checkoutStore} · {e.why}
                                </s-paragraph>
                              ))}
                            </s-stack>
                          )}
                          <CsvDownload intent="crosscheckCsv" filename={`${publicCode}-qualifying-orders.csv`} label="Download the qualifying orders (CSV)" />
                        </>
                      )}
                      {p.crosscheck && (
                        <s-paragraph>
                          Last check: Shopify {p.crosscheck.shopifyUnits}, app {p.crosscheck.appUnits} · {p.crosscheck.by} {pacific(p.crosscheck.at)}
                          {p.crosscheck.note ? ` · ${p.crosscheck.note}` : ""}
                          {!p.crosscheckCurrent && " · out of date: the payout changed since"}
                        </s-paragraph>
                      )}
                      <Form method="post">
                        <input type="hidden" name="intent" value="crosscheck" />
                        <s-stack direction="inline" gap="base" alignItems="end">
                          <s-number-field name="shopifyUnits" label="Units Shopify shows" required />
                          <s-text-field name="note" label="Note (required if different)" />
                          <s-button type="submit" disabled={busy}>Verified against Shopify</s-button>
                        </s-stack>
                      </Form>
                    </s-stack>
                  </s-box>

                  {p.individualPayee && !p.individualConfirmed && (
                    <s-banner tone="warning">
                      <s-paragraph>
                        The payee email is an organizer&apos;s own email: this pays an individual, not a club or school.
                      </s-paragraph>
                      <Form method="post">
                        <input type="hidden" name="intent" value="confirmPayee" />
                        <s-stack direction="inline" gap="base" alignItems="end">
                          <s-text-field name="note" label="I confirm paying an individual. Note:" required />
                          <s-button type="submit" disabled={busy}>Confirm</s-button>
                        </s-stack>
                      </Form>
                    </s-banner>
                  )}
                  {p.individualConfirmed && (
                    <s-paragraph>
                      Individual payee confirmed by {p.individualConfirmed.by} {pacific(p.individualConfirmed.at)}: {p.individualConfirmed.note}
                    </s-paragraph>
                  )}

                  {p.blockers.length > 0 ? (
                    <s-banner tone="warning">
                      <s-paragraph>Approval is blocked until:</s-paragraph>
                      <s-unordered-list>
                        {p.blockers.map((b) => (
                          <s-list-item key={b}>{b}</s-list-item>
                        ))}
                      </s-unordered-list>
                      {p.unresolvedFlags.length > 0 && <s-link href="#flags">Go to the flags</s-link>}
                    </s-banner>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="approve" />
                      <s-button type="submit" variant="primary" disabled={busy}>
                        Approve payout of {dollars(p.finalCents)}
                      </s-button>
                    </Form>
                  )}
                </>
              )}

              {p.status !== "draft" && (
                <s-stack gap="small">
                  <s-paragraph>
                    Approved by {p.approvedBy} {pacific(p.approvedAt)}. Frozen lines ({p.frozenLines.length}):{" "}
                    {p.frozenLines.map((l, i) => (
                      <span key={l.id}>
                        {i > 0 ? ", " : ""}
                        <s-link href={l.orderUrl} target="_blank">{l.orderName}</s-link> ({l.units})
                      </span>
                    ))}
                  </s-paragraph>
                </s-stack>
              )}

              {p.status === "approved" && (
                <>
                  <Form method="post">
                    <input type="hidden" name="intent" value="pay" />
                    <s-stack gap="small">
                      <s-heading>Record the PayPal payment</s-heading>
                      <s-stack direction="inline" gap="base" alignItems="end">
                        <s-date-field name="paidOn" label="Date paid" required />
                        <s-text-field name="reference" label="PayPal transaction ID" required />
                        <s-text-field name="amount" label="Amount sent ($)" defaultValue={(p.finalCents / 100).toFixed(2)} required />
                        <s-text-field name="note" label="Note (required if the amount differs)" />
                        <s-button type="submit" variant="primary" disabled={busy}>Record payment (final)</s-button>
                      </s-stack>
                    </s-stack>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reopen" />
                    <s-stack direction="inline" gap="base" alignItems="end">
                      <s-text-field name="reason" label="Reason to reopen as a draft" required />
                      <s-button type="submit" tone="critical" disabled={busy}>Reopen payout</s-button>
                    </s-stack>
                  </Form>
                </>
              )}

              {p.paid && (
                <s-paragraph>
                  Paid {dollars(p.paid.amountCents ?? 0)} by {p.paid.method} on {pacific(p.paid.at)} · reference {p.paid.reference} · recorded by{" "}
                  {p.paid.by}
                  {p.paid.note ? ` · ${p.paid.note}` : ""}. Paid is final.
                </s-paragraph>
              )}

              {p.changes.length > 0 && (
                <s-stack gap="small">
                  <s-heading>Refunds after the payout was frozen (accepted risk; the payout doesn&apos;t change)</s-heading>
                  {p.changes.map((c) => (
                    <s-stack key={c.id} direction="inline" gap="base" alignItems="center">
                      <s-text>
                        {c.orderName}: {c.lost} unit{c.lost === 1 ? "" : "s"} ({dollars(c.amountCents)} at the payout rate), {pacific(c.at)}
                      </s-text>
                      {!c.acknowledged && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="ackChange" />
                          <input type="hidden" name="changeId" value={c.id} />
                          <s-button type="submit" variant="tertiary" disabled={busy}>Mark as seen</s-button>
                        </Form>
                      )}
                    </s-stack>
                  ))}
                </s-stack>
              )}
            </>
          )}
        </s-stack>
      </s-section>
    </div>
  );
}
