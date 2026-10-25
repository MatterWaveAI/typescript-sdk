import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MatterWave } from "../src/client";
import { NotFoundError, PermissionDeniedError } from "../src/errors";

/**
 * The native clients against a RUNNING MatterWave API, not a stubbed fetch.
 *
 * Skipped unless MATTERWAVE_LOCAL_URL names an API started with
 * MW_AUTH_MODE=none on Postgres (web/e2e/playwright.local.config.ts has the
 * stack). Under that mode an unauthenticated request is the dev principal,
 * which mints the key these tests drive the SDK with -- the SDK itself
 * always sends a key.
 *
 * A key acts for its owner within its scopes: webhooks need
 * `webhooks:manage` and the org usage report `usage:read`, which the key
 * minted here does not hold, so both answer it with 403 -- asserted so a
 * change on either side is seen.
 */

const BASE = process.env.MATTERWAVE_LOCAL_URL ?? "";
const RUN = Date.now().toString(36);

describe.skipIf(!BASE)("native clients against a local API", () => {
  let client: MatterWave;
  let keyId = "";

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `sdk-ts-${RUN}`, scopes: ["chat:read", "chat:write", "keys:manage"] }),
    });
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string; key: string };
    keyId = minted.id;
    client = new MatterWave({ apiKey: minted.key, baseUrl: BASE, maxRetries: 0 });
  });

  afterAll(async () => {
    if (keyId) await fetch(`${BASE}/api/keys/${keyId}`, { method: "DELETE" });
  });

  it("keys: list, create, update, rotate, revoke", async () => {
    const made = await client.keys.create({ name: `sdk-child-${RUN}`, scopes: ["chat:read"], expires_in_days: 30 });
    expect(made.key).toBeTruthy();
    expect(made.scopes).toEqual(["chat:read"]);
    expect((await client.keys.list()).data.some((k) => k.id === made.id)).toBe(true);

    const updated = await client.keys.update(made.id, {
      name: `sdk-child-${RUN}-renamed`,
      rpm_limit: 30,
      expires_in_days: null,
    });
    expect(updated.name).toMatch(/-renamed$/);
    expect(updated.rpm_limit).toBe(30);
    expect(updated.expires_at).toBeNull();

    const rotated = await client.keys.rotate(made.id);
    expect(rotated.key).not.toBe(made.key);
    expect(rotated.previous_prefix).toBe(made.prefix);
    const child = new MatterWave({ apiKey: rotated.key, baseUrl: BASE, maxRetries: 0 });
    expect((await child.me()).subject).toBeTruthy();

    await client.keys.revoke(made.id);
    const row = (await client.keys.list()).data.find((k) => k.id === made.id);
    expect(row?.revoked_at).toBeTruthy();
    await expect(client.keys.revoke(crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("usage: the balance", async () => {
    const balance = await client.usage.get();
    expect(balance.unit).toBeTruthy();
    expect(balance.included).toBeGreaterThanOrEqual(0);
  });

  it("org usage and webhooks refuse a key without their scopes", async () => {
    await expect(client.usage.org()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(client.usage.exportCsv()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(client.webhooks.list()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      client.webhooks.create({ url: "https://example.com/hook", events: ["message.completed"] }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("attachments: upload, get, download, delete", async () => {
    const limits = await client.attachments.limits();
    expect(limits.max_upload_bytes).toBeGreaterThan(0);
    const text = `notes for ${RUN}\n`;
    const doc = await client.attachments.upload({ file: new TextEncoder().encode(text), filename: `notes-${RUN}.txt` });
    expect(doc.filename).toBe(`notes-${RUN}.txt`);
    const fetched = await client.attachments.get(doc.id);
    expect(fetched.download_url).toBeTruthy();
    if (fetched.scan_status === "clean") {
      expect(new TextDecoder().decode(await client.attachments.download(fetched))).toBe(text);
    }
    await client.attachments.delete(doc.id);
    await expect(client.attachments.get(doc.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("library: folders, tags, move, search", async () => {
    const conv = await client.conversations.create({ title: `sdk ts library ${RUN}` });
    const folder = await client.library.createFolder(`Folder ${RUN}`);
    const renamed = await client.library.updateFolder(folder.id, { name: `Folder ${RUN} renamed` });
    expect(renamed.name).toMatch(/renamed$/);
    expect((await client.library.move(conv.id, folder.id)).id).toBe(conv.id);
    const tag = await client.library.createTag(`tag-${RUN}`);
    expect((await client.library.setTags(conv.id, [tag.id])).tag_ids).toEqual([tag.id]);
    const library = await client.library.get();
    expect(library.folders.some((f) => f.id === folder.id)).toBe(true);
    expect(library.tags.some((t) => t.id === tag.id)).toBe(true);
    await client.library.search(`sdk ts library ${RUN}`, { limit: 5 });
    await client.library.move(conv.id, null);
    await client.library.deleteTag(tag.id);
    await client.library.deleteFolder(folder.id);
    expect((await client.library.get()).folders.some((f) => f.id === folder.id)).toBe(false);
  });

  it("shares: create, list, view, revoke", async () => {
    const conv = await client.conversations.create({ title: `sdk ts share ${RUN}` });
    // Nothing to share until there is a message: one turn, answered by the
    // stack's fake upstream.
    const stream = await client.conversations.send(conv.id, { content: "Hello there." });
    let reply = "";
    for await (const piece of stream.text()) reply += piece;
    expect(reply.length).toBeGreaterThan(0);

    const made = await client.shares.create(conv.id, { expires_in_s: 3600 });
    expect(made.token).toBeTruthy();
    expect((await client.shares.list(conv.id)).data.some((s) => s.id === made.share.id)).toBe(true);
    expect((await client.shares.listMine()).data.some((s) => s.id === made.share.id)).toBe(true);
    expect((await client.shares.view(made.token)).title).toBe(`sdk ts share ${RUN}`);
    await client.shares.revoke(made.share.id);
    await expect(client.shares.view(made.token)).rejects.toBeInstanceOf(NotFoundError);
  });
});
