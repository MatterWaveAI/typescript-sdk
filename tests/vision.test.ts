import { describe, expect, it } from "vitest";
import { visionOf, type AppModel } from "../src/index.js";

const ROWS: AppModel[] = [
  { id: "grt-vision", label: "GRT Vision", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: true, context_window: null, multiplier: 0, input_usd_per_m: 0, output_usd_per_m: 0 },
  { id: "grt-nano", label: "GRT Nano", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: false, context_window: null, multiplier: 0, input_usd_per_m: 0, output_usd_per_m: 0 },
  { id: "grt-mum", label: "GRT Mum", included: true, upgrade_to: null, partner: false, research_preview: false, supports_vision: null, context_window: null, multiplier: 0, input_usd_per_m: 0, output_usd_per_m: 0 },
  { id: "grt-bare", label: "GRT Bare", included: true, upgrade_to: null, partner: false, research_preview: false, context_window: null, multiplier: 0, input_usd_per_m: 0, output_usd_per_m: 0 },
];

describe("visionOf", () => {
  it("reads yes, no and null as they are sent", () => {
    expect(visionOf(ROWS, "grt-vision")).toBe("yes");
    expect(visionOf(ROWS, "grt-nano")).toBe("no");
    // Null is "the gateway did not say", not "no": allowed, and the
    // server's 422 is the authority.
    expect(visionOf(ROWS, "grt-mum")).toBe("unknown");
  });

  it("a row without the field and a model absent from the list are unknown", () => {
    expect(visionOf(ROWS, "grt-bare")).toBe("unknown");
    expect(visionOf(ROWS, "grt-someday")).toBe("unknown");
  });

  it("a null model and a null list are unknown", () => {
    // The picker's "Default" resolves server-side; the client cannot know
    // which model that is, so it does not guess.
    expect(visionOf(ROWS, null)).toBe("unknown");
    expect(visionOf(null, "grt-vision")).toBe("unknown");
    expect(visionOf(null, null)).toBe("unknown");
  });

  it("the refusing verdict is only no", () => {
    // The whole point of the tri-state: gate before the upload, refuse on
    // "no" alone, and let the server's 422 be the authority for the rest.
    expect(ROWS.map((row) => visionOf(ROWS, row.id) === "no")).toEqual([false, true, false, false]);
  });
});
