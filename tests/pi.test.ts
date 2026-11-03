/**
 * Pi 1.0 (`@earendil-works/pi-coding-agent`) SDK & RPC integration tests:
 * - `buildPiProviderConfig` with live `/v1/models` and fallback models
 * - `createMatterWavePiExtension` registering `"matterwave"`, `/preset` & `/temporary` commands, and `.env` / availability guardrails
 * - `PiRpcClient` JSON-Lines (`--mode rpc`) subprocess driver over `stdin`/`stdout`
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PI_MODELS,
  MATTERWAVE_PROVIDER_NAME,
  MatterWave,
  ORG_HEADER,
  PRESET_HEADER,
  PiRpcClient,
  TEMPORARY_HEADER,
  buildPiProviderConfig,
  createMatterWavePiExtension,
  pi,
  type PiCommandOptions,
  type PiExtensionAPI,
  type PiExtensionContext,
  type PiProviderConfig,
  type PiRpcEvent,
  type PiToolCallEvent,
  type PiToolCallResult,
} from "../src/index.js";
import * as piSubpath from "../src/pi/index.js";
import { API_KEY, BASE_URL, client, json, stubFetch } from "./helpers.js";

const MOCK_RPC_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.type === "get_state") {
    send({
      id: cmd.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId: "sess_mw_01",
        isStreaming: false,
        isCompacting: false,
        messageCount: 2,
        pendingMessageCount: 0,
        envKey: process.env.MATTERWAVE_API_KEY,
        envUrl: process.env.MATTERWAVE_BASE_URL,
      },
    });
  } else if (cmd.type === "set_model") {
    send({
      id: cmd.id,
      type: "response",
      command: "set_model",
      success: true,
      data: { provider: cmd.provider, id: cmd.modelId },
    });
  } else if (cmd.type === "compact") {
    send({
      id: cmd.id,
      type: "response",
      command: "compact",
      success: true,
      data: { summary: "Compacted context", customInstructions: cmd.customInstructions || null },
    });
  } else if (cmd.type === "steer") {
    send({
      id: cmd.id,
      type: "response",
      command: "steer",
      success: true,
      data: { disposition: "steered", message: cmd.message },
    });
  } else if (cmd.type === "follow_up") {
    send({
      id: cmd.id,
      type: "response",
      command: "follow_up",
      success: true,
      data: { disposition: "queued", message: cmd.message },
    });
  } else if (cmd.type === "new_session") {
    send({
      id: cmd.id,
      type: "response",
      command: "new_session",
      success: true,
      data: { cancelled: false, parentSession: cmd.parentSession || null },
    });
  } else if (cmd.type === "get_messages") {
    send({
      id: cmd.id,
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi!" }] },
    });
  } else if (cmd.type === "abort") {
    send({
      id: cmd.id,
      type: "response",
      command: "abort",
      success: true,
    });
    send({ type: "agent_end", messages: [] });
  } else if (cmd.type === "prompt") {
    if (cmd.message === "FAIL_RPC") {
      send({
        id: cmd.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "Synthetic RPC error",
      });
      return;
    }
    send({
      id: cmd.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    setTimeout(() => {
      send({ type: "agent_start" });
      send({ type: "turn_start", turnIndex: 0, timestamp: 1700000000000 });
      send({ type: "message_start", message: { role: "assistant", content: "" } });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Inspecting " },
      });
      send({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "src/index.ts" },
      });
      send({
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "src/index.ts" },
        partialResult: "1\\texport ...",
      });
      send({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { content: "1\\texport ..." },
        isError: false,
        durationMs: 12,
      });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done." },
      });
      send({
        type: "message_end",
        message: { role: "assistant", content: "Inspecting done." },
      });
      send({
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", content: "Inspecting done." },
        toolResults: [],
      });
      send({
        type: "agent_end",
        messages: [{ role: "assistant", content: "Inspecting done." }],
      });
    }, 10);
  }
});
`;

describe("Pi 1.0 module exports", () => {
  it("re-exports identical helpers from root and ./pi subpath", () => {
    expect(pi.buildPiProviderConfig).toBe(buildPiProviderConfig);
    expect(piSubpath.buildPiProviderConfig).toBe(buildPiProviderConfig);
    expect(piSubpath.createMatterWavePiExtension).toBe(createMatterWavePiExtension);
    expect(piSubpath.PiRpcClient).toBe(PiRpcClient);
    expect(piSubpath. isDeniedPath(".env")).toBe(true);
    expect(piSubpath.isDeniedPath("src/index.ts")).toBe(false);
  });
});

describe("buildPiProviderConfig", () => {
  it("maps live models from client.models.list() and sets MatterWave headers", async () => {
    const { fetch, seen } = stubFetch([
      json({
        object: "list",
        data: [
          { id: "grt-1", object: "model", created: 1700000000, owned_by: "matterwave" },
          { id: "custom-fermion-7b", object: "model", created: 1700000000, owned_by: "matterwave" },
        ],
      }),
    ]);
    const c = new MatterWave({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch,
      defaultHeaders: { "X-Custom": "1" },
    });

    const config = await buildPiProviderConfig(c, {
      presetId: "preset_research",
      temporary: true,
      orgId: "org_quantum",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE_URL}/v1/models`);
    expect(config.name).toBe("MatterWave");
    expect(config.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(config.apiKey).toBe(API_KEY);
    expect(config.api).toBe("openai-completions");
    expect(config.authHeader).toBe(true);
    expect(config.headers).toEqual({
      "X-Custom": "1",
      [PRESET_HEADER]: "preset_research",
      [TEMPORARY_HEADER]: "true",
      [ORG_HEADER]: "org_quantum",
    });
    expect(config.models.map((m) => m.id)).toEqual(["grt-1", "custom-fermion-7b"]);
    expect(config.models[0]!.contextWindow).toBe(256_000);
    expect(config.models[1]!.name).toBe("custom-fermion-7b");
    expect(config.models[1]!.api).toBe("openai-completions");
  });

  it("falls back to DEFAULT_PI_MODELS (or custom fallbackModels) when client.models.list() fails", async () => {
    const { fetch } = stubFetch([new Response("bad gateway", { status: 502 })]);
    const c = new MatterWave({
      apiKey: "mw_offline_key",
      baseUrl: BASE_URL,
      fetch,
      maxRetries: 0,
    });

    const config = await buildPiProviderConfig(c);
    expect(config.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(config.apiKey).toBe("mw_offline_key");
    expect(config.models.map((m) => m.id)).toEqual(DEFAULT_PI_MODELS.map((m) => m.id));

    const customFallback = [
      {
        id: "grt-edge-local",
        name: "GRT Edge Local",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 8_192,
      },
    ];
    const customConfig = await buildPiProviderConfig(c, { fallbackModels: customFallback });
    expect(customConfig.models).toEqual(customFallback);
  });
});

describe("createMatterWavePiExtension", () => {
  function createMockPiHost() {
    const providers = new Map<string, PiProviderConfig>();
    const commands = new Map<string, PiCommandOptions>();
    const toolCallHandlers: Array<
      (
        event: PiToolCallEvent,
        ctx?: PiExtensionContext,
      ) => Promise<PiToolCallResult | void | undefined> | PiToolCallResult | void | undefined
    > = [];

    const host: PiExtensionAPI = {
      registerProvider(name, config) {
        providers.set(name, config);
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      on(event, handler) {
        if (event === "tool_call") {
          toolCallHandlers.push(handler);
        }
      },
    };

    return {
      host,
      providers,
      commands,
      async runToolCall(event: PiToolCallEvent, ctx?: PiExtensionContext): Promise<PiToolCallResult | undefined> {
        for (const h of toolCallHandlers) {
          const res = await h(event, ctx);
          if (res) return res;
        }
        return undefined;
      },
    };
  }

  it("registers the matterwave provider, /preset & /temporary commands, and blocks .env tool calls", async () => {
    const { fetch } = stubFetch([
      json({ object: "list", data: [{ id: "grt-1", object: "model", created: 1, owned_by: "matterwave" }] }),
      json({ object: "list", data: [{ id: "grt-1", object: "model", created: 1, owned_by: "matterwave" }] }),
      json({ object: "list", data: [{ id: "grt-1", object: "model", created: 1, owned_by: "matterwave" }] }),
      json({ object: "list", data: [{ id: "grt-1", object: "model", created: 1, owned_by: "matterwave" }] }),
    ]);
    const c = client(fetch);
    const { host, providers, commands, runToolCall } = createMockPiHost();

    const ext = createMatterWavePiExtension(c, { presetId: "initial_preset" });
    await ext(host);

    // 1. Provider registration
    const initialProvider = providers.get(MATTERWAVE_PROVIDER_NAME);
    expect(initialProvider).toBeDefined();
    expect(initialProvider!.headers?.[PRESET_HEADER]).toBe("initial_preset");
    expect(initialProvider!.headers?.[TEMPORARY_HEADER]).toBeUndefined();

    // 2. /preset and /temporary commands update provider headers and UI status
    const notices: string[] = [];
    const statuses = new Map<string, string | undefined>();
    const uiCtx: PiExtensionContext = {
      ui: {
        notify: (msg) => notices.push(msg),
        setStatus: (k, v) => statuses.set(k, v),
      },
    };

    expect(commands.has("preset")).toBe(true);
    expect(commands.has("temporary")).toBe(true);

    await commands.get("preset")!.handler("preset_sec_ops", uiCtx);
    expect(providers.get(MATTERWAVE_PROVIDER_NAME)!.headers?.[PRESET_HEADER]).toBe("preset_sec_ops");
    expect(statuses.get("matterwave-preset")).toBe("preset:preset_sec_ops");

    await commands.get("preset")!.handler("off", uiCtx);
    expect(providers.get(MATTERWAVE_PROVIDER_NAME)!.headers?.[PRESET_HEADER]).toBeUndefined();
    expect(statuses.get("matterwave-preset")).toBeUndefined();

    await commands.get("temporary")!.handler("on", uiCtx);
    expect(providers.get(MATTERWAVE_PROVIDER_NAME)!.headers?.[TEMPORARY_HEADER]).toBe("true");
    expect(statuses.get("matterwave-temporary")).toBe("temp:on");
    expect(notices.length).toBeGreaterThanOrEqual(3);

    // 3. Guardrail blocks .env, *.pem, .git/ and shell commands reading .env
    const blockedEnv = await runToolCall({
      type: "tool_call",
      toolCallId: "tc_1",
      toolName: "read",
      input: { path: ".env" },
    });
    expect(blockedEnv?.block).toBe(true);
    expect(blockedEnv?.reason).toContain(".env");

    const blockedNestedEnv = await runToolCall({
      type: "tool_call",
      toolCallId: "tc_2",
      toolName: "edit",
      input: { path: "config/.env.production" },
    });
    expect(blockedNestedEnv?.block).toBe(true);
    expect(blockedNestedEnv?.reason).toContain("config/.env.production");

    const blockedBashEnv = await runToolCall({
      type: "tool_call",
      toolCallId: "tc_3",
      toolName: "bash",
      input: { command: "cat .env.local" },
    });
    expect(blockedBashEnv?.block).toBe(true);
    expect(blockedBashEnv?.reason).toContain(".env.local");

    const allowedRead = await runToolCall({
      type: "tool_call",
      toolCallId: "tc_4",
      toolName: "read",
      input: { path: "src/index.ts" },
    });
    expect(allowedRead).toBeUndefined();

    // 4. Guardrail blocks when project is untrusted via agentAvailability
    const blockedUntrusted = await runToolCall(
      {
        type: "tool_call",
        toolCallId: "tc_5",
        toolName: "read",
        input: { path: "src/index.ts" },
      },
      { isProjectTrusted: () => false },
    );
    expect(blockedUntrusted?.block).toBe(true);
    expect(blockedUntrusted?.reason).toContain("untrusted workspace");
  });
});

describe("PiRpcClient", () => {
  it("spawns the RPC subprocess with MatterWave env, correlates commands, streams events, and closes cleanly", async () => {
    const { fetch } = stubFetch([]);
    const c = client(fetch);

    const rpc = new PiRpcClient({
      client: c,
      command: process.execPath,
      args: ["-e", MOCK_RPC_SCRIPT],
    });

    try {
      expect(rpc.pid).toBeTypeOf("number");

      // 1. Check state & injected environment variables
      const state = await rpc.getState();
      expect(state.success).toBe(true);
      expect(state.sessionId).toBe("sess_mw_01");
      expect(state.envKey).toBe(API_KEY);
      expect(state.envUrl).toBe(BASE_URL);

      // 2. Test setModel & compact commands
      const modelRes = await rpc.setModel("matterwave", "grt-1");
      expect(modelRes.success).toBe(true);
      expect(modelRes.provider).toBe("matterwave");
      expect(modelRes.id).toBe("grt-1");

      const compactRes = await rpc.compact("Keep architecture decisions");
      expect(compactRes.success).toBe(true);
      expect(compactRes.data).toEqual({
        summary: "Compacted context",
        customInstructions: "Keep architecture decisions",
      });

      const steerRes = await rpc.steer("Focus on error handling");
      expect(steerRes.success).toBe(true);
      expect(steerRes.disposition).toBe("steered");

      const followUpRes = await rpc.followUp("Run tests next");
      expect(followUpRes.success).toBe(true);
      expect(followUpRes.disposition).toBe("queued");

      const newSessionRes = await rpc.newSession("sess_parent_00");
      expect(newSessionRes.success).toBe(true);
      expect(newSessionRes.cancelled).toBe(false);

      const messagesRes = await rpc.getMessages();
      expect(messagesRes.success).toBe(true);
      expect(messagesRes.messages).toHaveLength(2);

      // 3. Stream events from a prompt turn via both onEvent and events() async iterator
      const seenByCallback: PiRpcEvent[] = [];
      const unsub = rpc.onEvent((ev) => seenByCallback.push(ev));

      const iterEvents: PiRpcEvent[] = [];
      const iterDone = (async () => {
        for await (const ev of rpc.events()) {
          iterEvents.push(ev);
          if (ev.type === "agent_end") break;
        }
      })();

      const promptRes = await rpc.prompt("Read src/index.ts");
      expect(promptRes.success).toBe(true);
      expect(promptRes.disposition).toBe("started");

      await iterDone;
      unsub();

      const eventTypes = iterEvents.map((e) => e.type);
      expect(eventTypes).toContain("agent_start");
      expect(eventTypes).toContain("turn_start");
      expect(eventTypes).toContain("message_start");
      expect(eventTypes).toContain("message_update");
      expect(eventTypes).toContain("tool_execution_start");
      expect(eventTypes).toContain("tool_execution_update");
      expect(eventTypes).toContain("tool_execution_end");
      expect(eventTypes).toContain("message_end");
      expect(eventTypes).toContain("turn_end");
      expect(eventTypes).toContain("agent_end");

      const deltas = iterEvents
        .filter((e): e is Extract<PiRpcEvent, { type: "message_update" }> => e.type === "message_update")
        .map((e) => e.assistantMessageEvent?.delta)
        .join("");
      expect(deltas).toBe("Inspecting done.");

      const toolStart = iterEvents.find(
        (e): e is Extract<PiRpcEvent, { type: "tool_execution_start" }> => e.type === "tool_execution_start",
      );
      expect(toolStart?.toolName).toBe("read");
      expect(toolStart?.args).toEqual({ path: "src/index.ts" });

      const toolEnd = iterEvents.find(
        (e): e is Extract<PiRpcEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
      );
      expect(toolEnd?.isError).toBe(false);
      expect(toolEnd?.durationMs).toBe(12);

      expect(seenByCallback.length).toBeGreaterThanOrEqual(iterEvents.length);

      // 4. Test abort command and error response handling
      const abortRes = await rpc.abort();
      expect(abortRes.success).toBe(true);

      await expect(rpc.prompt("FAIL_RPC")).rejects.toThrow("Synthetic RPC error");
    } finally {
      await rpc.close();
    }
  });
});

describe("client.pi namespace", () => {
  it("exposes buildProviderConfig, createExtension, and createRpcClient bound to the MatterWave client", async () => {
    const { fetch, seen } = stubFetch([
      json({
        object: "list",
        data: [{ id: "grt-1", object: "model", created: 1700000000, owned_by: "matterwave" }],
      }),
      json({
        object: "list",
        data: [{ id: "grt-1", object: "model", created: 1700000000, owned_by: "matterwave" }],
      }),
    ]);
    const c = new MatterWave({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch,
      defaultHeaders: { "X-Client-Header": "bound" },
    });

    expect(c.pi).toBe(c.pi);

    // 1. client.pi.buildProviderConfig()
    const cfg = await c.pi.buildProviderConfig({
      presetId: "preset_bound",
      temporary: true,
    });
    expect(seen).toHaveLength(1);
    expect(cfg.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(cfg.apiKey).toBe(API_KEY);
    expect(cfg.headers).toEqual({
      "X-Client-Header": "bound",
      [PRESET_HEADER]: "preset_bound",
      [TEMPORARY_HEADER]: "true",
    });
    expect(cfg.models.map((m) => m.id)).toEqual(["grt-1"]);

    // 2. client.pi.createExtension()
    const registeredProviders = new Map<string, PiProviderConfig>();
    const registeredCommands = new Map<string, PiCommandOptions>();
    const ext = c.pi.createExtension({ presetId: "preset_ext" });
    await ext({
      registerProvider(name, providerCfg) {
        registeredProviders.set(name, providerCfg);
      },
      registerCommand(name, cmdOpts) {
        registeredCommands.set(name, cmdOpts);
      },
      on() {},
    });
    expect(registeredProviders.get(MATTERWAVE_PROVIDER_NAME)?.headers?.[PRESET_HEADER]).toBe("preset_ext");
    expect(registeredCommands.has("preset")).toBe(true);
    expect(registeredCommands.has("temporary")).toBe(true);

    // 3. client.pi.createRpcClient()
    const rpc = c.pi.createRpcClient({
      command: process.execPath,
      args: ["-e", MOCK_RPC_SCRIPT],
    });
    try {
      const state = await rpc.getState();
      expect(state.success).toBe(true);
      expect(state.envKey).toBe(API_KEY);
      expect(state.envUrl).toBe(BASE_URL);
    } finally {
      await rpc.close();
    }

    // 4. client.pi.streamPrompt()
    const streamedEvents: PiRpcEvent[] = [];
    for await (const ev of c.pi.streamPrompt("Stream via helper", {
      command: process.execPath,
      args: ["-e", MOCK_RPC_SCRIPT],
    })) {
      streamedEvents.push(ev);
    }
    const streamedTypes = streamedEvents.map((e) => e.type);
    expect(streamedTypes).toContain("agent_start");
    expect(streamedTypes).toContain("message_update");
    expect(streamedTypes).toContain("turn_end");
    const streamedText = streamedEvents
      .filter((e): e is Extract<PiRpcEvent, { type: "message_update" }> => e.type === "message_update")
      .map((e) => e.assistantMessageEvent?.delta)
      .join("");
    expect(streamedText).toBe("Inspecting done.");
  });
});
