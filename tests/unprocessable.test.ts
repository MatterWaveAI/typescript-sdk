/**
 * The 422 refusal as its own class: FastAPI's validation shape, with the
 * per-field messages joined onto the error.
 */

import { describe, expect, it } from "vitest";
import { UnprocessableEntityError } from "../src/index.js";
import { client, text, stubFetch } from "./helpers.js";

const FASTAPI_422 = {
  detail: [{ loc: ["body", "url"], msg: "The URL does not resolve.", type: "value_error" }],
};

describe("UnprocessableEntityError", () => {
  it("a 422 is its own error with the fields joined", async () => {
    const { fetch } = stubFetch([
      text(JSON.stringify(FASTAPI_422), 422, { "X-Request-Id": "req-422" }),
    ]);
    const error = await client(fetch)
      .webhooks.create({ url: "https://nowhere.test", events: ["ping"] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityError);
    const unprocessable = error as UnprocessableEntityError;
    expect(unprocessable.status).toBe(422);
    expect(unprocessable.requestId).toBe("req-422");
    expect(unprocessable.message).toContain("The URL does not resolve.");
    expect(unprocessable.body).toEqual(FASTAPI_422);
  });

  it("the same class on the /v1 surface", async () => {
    const { fetch } = stubFetch([text(JSON.stringify(FASTAPI_422), 422)]);
    await expect(
      client(fetch).chat.completions.create({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });
});
