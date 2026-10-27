/** The budget pane's routes: read the balance, move the caps. Reads are any member's; writes are an owner or admin's and are checked the way the existing resources check theirs. */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

function budget(extra: Record<string, unknown> = {}) {
  return {
    period_start: "2026-10-01",
    included_tokens: 2_000_000,
    tokens_used: 1_250_000,
    remaining_tokens: 750_000,
    overage_enabled: true,
    overage_cap_micros: 5_000_000,
    overage_micros: 0,
    member_default_cap_micros: null,
    member_cap: null,
    member_spent: 0,
    member_exhausted: false,
    ...extra,
  };
}

function memberBudget(extra: Record<string, unknown> = {}) {
  return {
    subject: "u-1",
    period_start: "2026-10-01",
    cap_micros: null,
    own: false,
    spent_micros: 42_000,
    exhausted: false,
    ...extra,
  };
}

const MEMBERS = {
  period_start: "2026-10-01",
  member_default_cap_micros: null,
  data: [
    memberBudget({ email: "a@example.test", name: "Ada", role: "owner", state: "active" }),
    memberBudget({
      subject: "u-2",
      cap_micros: 1_000_000,
      own: true,
      exhausted: true,
      email: "b@example.test",
      name: "Bob",
      role: "member",
      state: "active",
    }),
  ],
};

describe("budget", () => {
  it("get reads the balance and the caller's own cap", async () => {
    const { fetch, seen } = stubFetch([json(budget())]);
    const budgetRow = await client(fetch).budget.get();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/budget`);
    expect(budgetRow.remaining_tokens).toBe(750_000);
    expect(budgetRow.included_tokens).toBe(2_000_000);
    expect(budgetRow.overage_enabled).toBe(true);
    expect(budgetRow.overage_cap_micros).toBe(5_000_000);
    expect(budgetRow.member_cap).toBeNull();
    expect(budgetRow.member_exhausted).toBe(false);
    expect(budgetRow.requestId).toBe(REQUEST_ID);
  });

  it("setOverageCap puts the number and refuses a negative one", async () => {
    const { fetch, seen } = stubFetch([json(budget({ overage_cap_micros: 10_000_000 }))]);
    const updated = await client(fetch).budget.setOverageCap({ overage_cap_micros: 10_000_000 });
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/budget`);
    expect(seen[0]!.body).toEqual({ overage_cap_micros: 10_000_000 });
    expect(updated.overage_cap_micros).toBe(10_000_000);
    expect(() => client(fetch).budget.setOverageCap({ overage_cap_micros: -1 })).toThrow(
      MatterWaveConfigError,
    );
    expect(seen).toHaveLength(1);
  });

  it("members reads rows and setMemberDefaultCap puts the cap, null included", async () => {
    const { fetch, seen } = stubFetch([
      json(MEMBERS),
      json({ ...MEMBERS, member_default_cap_micros: 2_000_000 }),
      json({ ...MEMBERS, member_default_cap_micros: null }),
    ]);
    const members = await client(fetch).budget.members();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/budget/members`);
    expect(members.data.map((m) => m.subject)).toEqual(["u-1", "u-2"]);
    expect(members.data[1]!.own).toBe(true);
    expect(members.data[1]!.exhausted).toBe(true);
    expect(members.data[1]!.cap_micros).toBe(1_000_000);
    expect(members.data[1]!.email).toBe("b@example.test");

    const raised = await client(fetch).budget.setMemberDefaultCap({ member_default_cap_micros: 2_000_000 });
    expect(raised.member_default_cap_micros).toBe(2_000_000);
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.body).toEqual({ member_default_cap_micros: 2_000_000 });
    // null lifts the default, and is sent rather than dropped.
    await client(fetch).budget.setMemberDefaultCap({ member_default_cap_micros: null });
    expect(seen[2]!.body).toEqual({ member_default_cap_micros: null });
  });

  it("setMemberCap addresses the subject and accepts null", async () => {
    const { fetch, seen } = stubFetch([json(memberBudget({ cap_micros: 1_000_000, own: true }))]);
    const capped = await client(fetch).budget.setMemberCap("u-2", { cap_micros: 1_000_000 });
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/budget/members/u-2`);
    expect(seen[0]!.body).toEqual({ cap_micros: 1_000_000 });
    expect(capped.own).toBe(true);
    expect(capped.cap_micros).toBe(1_000_000);
    expect(() => client(fetch).budget.setMemberCap("../keys", { cap_micros: 1 })).toThrow(
      MatterWaveConfigError,
    );
  });
});
