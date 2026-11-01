/**
 * The billing resources: the public plan catalog (`plans.list`), the move to Free, the
 * billing trail, and the Stripe checkout, portal, status and invoices.
 * Each test answers with the body the route in api/matterwave sends and
 * checks the request the client made.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

function planRow(extra: Record<string, unknown> = {}) {
  return {
    code: "free",
    name: "Free",
    price_cents_monthly: 0,
    price_cents_annual: 0,
    included_tokens: 250000,
    included_tokens_per_seat: null,
    per_seat: false,
    overage_enabled: false,
    default_overage_cap_micros: 0,
    trial_days: 0,
    models: ["grt-nano"],
    limits: { included_tokens: 250000, max_conversations: 50 },
    ...extra,
  };
}

function entitlementRow(extra: Record<string, unknown> = {}) {
  return {
    org_id: "org-01",
    plan: "scale",
    plan_name: "Scale",
    status: "active",
    seats: 3,
    per_seat: false,
    billed_seats: 1,
    price_cents_monthly: 5000,
    price_cents_annual: 48000,
    implicit: false,
    billing_interval: "month",
    current_period_end: "2026-11-30T09:00:00+00:00",
    cancel_at_period_end: false,
    trial_end: null,
    default_overage_cap_micros: 5000000,
    limits: {},
    over_capacity: 0,
    writes_blocked: false,
    read_only_reason: null,
    dunning_stage: "clear",
    ...extra,
  };
}

describe("billing", () => {
  it("reads the public catalog without a key", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [planRow(), planRow({ code: "scale", name: "Scale", price_cents_monthly: 5000 })],
        models: [
          { model: "grt-nano", label: "GRT Nano", multiplier: 1, input_usd_per_m: 0.15, output_usd_per_m: 0.6, partner: false, research_preview: false, context_window: 128000 },
        ],
        default_model: "grt-nano",
      }),
    ]);
    const catalog = await client(fetch).plans.list();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/plans`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(catalog.data[1]!.code).toBe("scale");
    expect(catalog.default_model).toBe("grt-nano");
    expect(catalog.models[0]!.input_usd_per_m).toBe(0.15);
    expect(catalog.requestId).toBe(REQUEST_ID);
  });

  it("changes the plan to Free with the reason", async () => {
    const { fetch, seen } = stubFetch([
      json(entitlementRow({ plan: "free", plan_name: "Free", status: "active" })),
    ]);
    const moved = await client(fetch).billing.changePlan("free", { reason: "offboarding" });
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/plan`);
    expect(seen[0]!.body).toEqual({ plan: "free", reason: "offboarding" });
    expect(moved.plan).toBe("free");
  });

  it("omits the reason when there is none", async () => {
    const { fetch, seen } = stubFetch([json(entitlementRow())]);
    await client(fetch).billing.changePlan("free");
    expect(seen[0]!.body).toEqual({ plan: "free" });
  });

  it("refuses a change without a plan code before sending", () => {
    const { fetch, calls } = stubFetch([json({})]);
    expect(() => client(fetch).billing.changePlan("")).toThrow(MatterWaveConfigError);
    expect(calls()).toBe(0);
  });

  it("reads the append-only billing trail", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [
          {
            from_plan: "free",
            to_plan: "scale",
            from_status: "active",
            to_status: "active",
            kind: "upgrade",
            actor: "sub-ada",
            reason: "checkout.session.completed",
            metadata: { event_id: "evt_01" },
            created_at: "2026-10-01T09:00:00+00:00",
          },
        ],
      }),
    ]);
    const history = await client(fetch).billing.planHistory();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/plan/history`);
    expect(history.data[0]!.kind).toBe("upgrade");
    expect(history.data[0]!.metadata).toEqual({ event_id: "evt_01" });
  });

  it("starts a checkout, monthly by default", async () => {
    const { fetch, seen } = stubFetch([json({ url: "https://checkout.stripe.com/c/pay/cs_01" })]);
    const started = await client(fetch).billing.checkout("scale");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/billing/checkout`);
    expect(seen[0]!.body).toEqual({ plan: "scale", annual: false });
    expect(started.url).toContain("stripe.com");
  });

  it("starts an annual checkout when asked", async () => {
    const { fetch, seen } = stubFetch([json({ url: "https://checkout.stripe.com/c/pay/cs_02" })]);
    await client(fetch).billing.checkout("scale", { annual: true });
    expect(seen[0]!.body).toEqual({ plan: "scale", annual: true });
  });

  it("opens the customer portal", async () => {
    const { fetch, seen } = stubFetch([json({ url: "https://billing.stripe.com/p/session/01" })]);
    const portal = await client(fetch).billing.portal();
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/billing/portal`);
    expect(portal.url).toContain("billing.stripe.com");
  });

  it("reads the one-call billing status", async () => {
    const { fetch, seen } = stubFetch([
      json(
        entitlementRow({
          billing_enabled: true,
          collection_method: "charge_automatically",
          days_until_due: null,
          dunning: null,
        }),
      ),
    ]);
    const status = await client(fetch).billing.status();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/billing/status`);
    expect(status.billing_enabled).toBe(true);
    expect(status.collection_method).toBe("charge_automatically");
    expect(status.dunning).toBeNull();
    expect(status.writes_blocked).toBe(false);
  });

  it("reads a late-payment status's dunning state", async () => {
    const { fetch } = stubFetch([
      json(
        entitlementRow({
          dunning_stage: "limited",
          billing_enabled: true,
          collection_method: "send_invoice",
          days_until_due: 14,
          dunning: {
            stage: "limited",
            source: "invoice",
            first_overdue_at: "2026-10-20T00:00:00+00:00",
            days_overdue: 11,
            outstanding_micros: 5000000,
            schedule: {},
            next_step: { stage: "suspended", at: "2026-11-05T00:00:00+00:00" },
            overage_stopped: true,
            limited: { stops_overage: true, blocks_new_keys: true, blocks_upgrades: true },
            auto_suspend: true,
          },
        }),
      ),
    ]);
    const status = await client(fetch).billing.status();
    expect(status.dunning!.stage).toBe("limited");
    expect(status.dunning!.next_step!.stage).toBe("suspended");
    expect(status.days_until_due).toBe(14);
  });

  it("lists the invoices with Stripe's links", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [
          {
            id: "in_01",
            number: "MW-0007",
            status: "paid",
            collection_method: "charge_automatically",
            currency: "usd",
            amount_due_micros: 50000000,
            amount_remaining_micros: 0,
            due_at: "2026-10-05T00:00:00+00:00",
            paid_at: "2026-10-02T12:00:00+00:00",
            hosted_invoice_url: "https://invoice.stripe.com/i/01",
            invoice_pdf: "https://invoice.stripe.com/i/01/pdf",
            issued_at: "2026-10-01T00:00:00+00:00",
          },
        ],
      }),
    ]);
    const listed = await client(fetch).billing.invoices();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/billing/invoices`);
    expect(listed.data[0]!.number).toBe("MW-0007");
    expect(listed.data[0]!.paid_at).toContain("2026-10-02");
  });
});
