import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceAuthError, type DeviceCode } from "../src/index.js";
import { BASE_URL, client, json, recordSleeps, stubFetch } from "./helpers.js";

const START = {
  device_code: "dev-secret-half",
  user_code: "WDJB-MJHT",
  verification_uri: `${BASE_URL}/device`,
  verification_uri_complete: `${BASE_URL}/device?user_code=WDJB-MJHT`,
  expires_in: 600,
  interval: 5,
};
const TOKEN = { token_type: "Bearer", access_token: "mw_device_issued", scopes: ["chat:read", "chat:write"] };

const refusal = (error: string, status = 400) => json({ error }, status);

let sleeps: number[];
let restore: () => void;
beforeEach(() => {
  ({ sleeps, restore } = recordSleeps());
});
afterEach(() => restore());

describe("device login", () => {
  it("start needs no key and names the client", async () => {
    const { fetch, seen } = stubFetch([json(START)]);
    const code = await client(fetch, { apiKey: null }).auth.device.start({ client_name: "matterwave-vscode" });
    expect(code.user_code).toBe("WDJB-MJHT");
    expect(seen[0]!.url).toBe(`${BASE_URL}/api/auth/device`);
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    expect(seen[0]!.body).toEqual({ client_name: "matterwave-vscode" });
  });

  it("poll throws the RFC code while pending", async () => {
    const { fetch } = stubFetch([refusal("authorization_pending")]);
    const err = await client(fetch).auth.device.poll("dev-secret-half").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).code).toBe("authorization_pending");
    expect((err as DeviceAuthError).status).toBe(400);
  });

  it("login polls through pending and slow_down to the token", async () => {
    const { fetch, seen } = stubFetch([
      json(START),
      refusal("authorization_pending"),
      refusal("slow_down"),
      refusal("authorization_pending"),
      json(TOKEN),
    ]);
    const shown: DeviceCode[] = [];
    const token = await client(fetch, { apiKey: null }).auth.device.login({
      onCode: (code) => shown.push(code),
      timeoutMs: 120_000,
    });
    expect(shown.map((c) => c.user_code)).toEqual(["WDJB-MJHT"]);
    expect(token.access_token).toBe("mw_device_issued");
    expect(token.scopes).toEqual(["chat:read", "chat:write"]);
    expect(seen.slice(1).every((s) => (s.body as { device_code: string }).device_code === "dev-secret-half")).toBe(true);
    // The interval, then five seconds more for good after the slow_down.
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
  });

  it.each(["access_denied", "expired_token"])("login stops on %s", async (code) => {
    const { fetch } = stubFetch([json(START), refusal("authorization_pending"), refusal(code)]);
    const err = await client(fetch).auth.device.login({ onCode: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).code).toBe(code);
  });

  it("awaits an async onCode before polling", async () => {
    const order: string[] = [];
    const { fetch } = stubFetch([json(START), () => (order.push("poll"), json(TOKEN))]);
    await client(fetch).auth.device.login({
      onCode: async () => {
        await Promise.resolve();
        order.push("shown");
      },
    });
    expect(order).toEqual(["shown", "poll"]);
  });

  it("the token is an ordinary bearer", async () => {
    const { fetch, seen } = stubFetch([json({ subject: "u-1", kind: "key", roles: [] })]);
    await client(fetch, { apiKey: TOKEN.access_token }).me();
    expect(seen[0]!.headers.Authorization).toBe("Bearer mw_device_issued");
  });
});
