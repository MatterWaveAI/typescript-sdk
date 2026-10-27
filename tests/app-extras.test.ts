/**
 * The routes 0.2 added that are neither the conversation tree nor the
 * settings panes' native clients: the model picker (`appModels`), custom
 * instructions (user and org level), and reply feedback (`messages`). Each
 * test answers with the body the route in api/matterwave sends and checks
 * the request the client made and what it parsed.
 */

import { describe, expect, it } from "vitest";
import { FEEDBACK_REASONS, MatterWaveConfigError } from "../src/index.js";
import type { FeedbackRating } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

describe("appModels", () => {
  it("reads the picker rows and the default", async () => {
    const { fetch, seen } = stubFetch([
      json({
        object: "list",
        default_model: "grt-nano",
        data: [
          {
            id: "grt-nano",
            label: "GRT Nano",
            multiplier: 1,
            input_usd_per_m: 0.15,
            output_usd_per_m: 0.6,
            partner: false,
            research_preview: false,
            context_window: 128000,
            included: true,
            upgrade_to: null,
          },
          {
            id: "grt-max",
            label: "GRT Max",
            multiplier: 12,
            input_usd_per_m: 2.5,
            output_usd_per_m: 10.0,
            partner: false,
            research_preview: false,
            context_window: 200000,
            included: false,
            upgrade_to: "scale",
          },
        ],
      }),
    ]);
    const listed = await client(fetch).appModels();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/models`);
    expect(listed.default_model).toBe("grt-nano");
    expect(listed.requestId).toBe(REQUEST_ID);
    expect(listed.data.map((m) => m.id)).toEqual(["grt-nano", "grt-max"]);
    const [nano, paid] = listed.data;
    expect(nano!.included).toBe(true);
    expect(nano!.upgrade_to).toBeNull();
    expect(nano!.context_window).toBe(128000);
    expect(paid!.included).toBe(false);
    expect(paid!.upgrade_to).toBe("scale");
    expect(paid!.input_usd_per_m).toBe(2.5);
    expect(paid!.multiplier).toBe(12);
  });

  it("keeps unknown flags optional", async () => {
    // A row the gateway annotated with nothing: what the route always
    // prices and gates arrives, and what it does not (supports_vision) is
    // simply absent.
    const { fetch } = stubFetch([
      json({
        object: "list",
        default_model: null,
        data: [
          {
            id: "m",
            label: "M",
            multiplier: 1,
            input_usd_per_m: 0,
            output_usd_per_m: 0,
            partner: false,
            research_preview: false,
            context_window: null,
            included: true,
            upgrade_to: null,
          },
        ],
      }),
    ]);
    const model = (await client(fetch).appModels()).data[0]!;
    expect(model.included).toBe(true);
    expect(model.upgrade_to).toBeNull();
    expect(model.context_window).toBeNull();
    expect(model.supports_vision).toBeUndefined();
  });
});

describe("instructions", () => {
  it("reads and replaces the user's two fields", async () => {
    const { fetch, seen } = stubFetch([
      json({ about: "I am a Python developer.", style: "Be concise." }),
      json({ about: "I am a Python developer.", style: "" }),
    ]);
    const mine = await client(fetch).instructions.user();
    expect(mine.about).toBe("I am a Python developer.");
    expect(mine.style).toBe("Be concise.");
    expect(mine.requestId).toBe(REQUEST_ID);
    const saved = await client(fetch).instructions.updateUser({ about: "I am a Python developer." });
    expect(saved.style).toBe("");
    // Both fields always go: the route replaces the pair.
    expect(seen[1]!.body).toEqual({ about: "I am a Python developer.", style: "" });
    expect(seen[1]!.method).toBe("PUT");
    expect(seen[1]!.url).toBe(`${BASE_URL}/api/me/instructions`);
  });

  it("reads and replaces the org's text", async () => {
    const { fetch, seen } = stubFetch([
      json({ text: "" }),
      json({ text: "Never quote customer names." }),
      json({ text: "" }),
    ]);
    expect((await client(fetch).instructions.org()).text).toBe("");
    const saved = await client(fetch).instructions.updateOrg({ text: "Never quote customer names." });
    expect(saved.text).toBe("Never quote customer names.");
    expect(saved.requestId).toBe(REQUEST_ID);
    expect(seen[1]!.body).toEqual({ text: "Never quote customer names." });
    // An empty text clears the org level rather than being refused.
    await client(fetch).instructions.updateOrg({ text: "" });
    expect(seen[2]!.body).toEqual({ text: "" });
  });
});

describe("messages feedback", () => {
  it("sends the rating and parses the row", async () => {
    const { fetch, seen } = stubFetch([
      json({
        message_id: "m-asst",
        rating: -1,
        reasons: ["wrong", "unhelpful"],
        comment: "Missed the point.",
        created_at: "2026-10-18T09:00:00+00:00",
        updated_at: "2026-10-18T09:00:00+00:00",
      }),
    ]);
    const feedback = await client(fetch).messages.setFeedback("m-asst", -1, {
      reasons: ["wrong", "unhelpful"],
      comment: "Missed the point.",
    });
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/messages/m-asst/feedback`);
    expect(seen[0]!.body).toEqual({
      rating: -1,
      reasons: ["wrong", "unhelpful"],
      comment: "Missed the point.",
    });
    expect(feedback.rating).toBe(-1);
    expect(feedback.comment).toBe("Missed the point.");
    expect(feedback.requestId).toBe(REQUEST_ID);
  });

  it("defaults the optional fields to the server's own", async () => {
    const { fetch, seen } = stubFetch([json({ message_id: "m-asst", rating: 1, reasons: [], comment: null })]);
    const feedback = await client(fetch).messages.setFeedback("m-asst", 1);
    expect(seen[0]!.body).toEqual({ rating: 1, reasons: [], comment: null });
    expect(feedback.rating).toBe(1);
  });

  it("validates before sending", () => {
    const { fetch, seen } = stubFetch([]);
    expect(() => client(fetch).messages.setFeedback("m-asst", 0 as FeedbackRating)).toThrow(
      MatterWaveConfigError,
    );
    expect(() =>
      // @ts-expect-error -- a reason outside the vocabulary is refused here first
      client(fetch).messages.setFeedback("m-asst", 1, { reasons: ["vibes"] }),
    ).toThrow(MatterWaveConfigError);
    expect(() => client(fetch).messages.setFeedback("../keys", 1)).toThrow(MatterWaveConfigError);
    expect(seen).toHaveLength(0);
  });

  it("deleteFeedback reads removed or none", async () => {
    const { fetch, seen } = stubFetch([json({ status: "removed" }), json({ status: "none" })]);
    expect((await client(fetch).messages.deleteFeedback("m-asst")).status).toBe("removed");
    expect((await client(fetch).messages.deleteFeedback("m-asst")).status).toBe("none");
    expect(seen.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/messages/m-asst/feedback`);
  });

  it("names the vocabulary the reasons draw from", () => {
    expect([...FEEDBACK_REASONS]).toContain("wrong");
  });
});
