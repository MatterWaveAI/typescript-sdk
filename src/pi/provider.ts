/**
 * Pi 1.0 (`@earendil-works/pi-coding-agent`) provider configuration builder
 * and extension factory for MatterWave & GRT models, presets, temporary
 * sessions, and local path/availability guardrails.
 */

import { agentAvailability, isDeniedPath, refusal } from "../agent/index.js";
import { API_KEY_ENV, type MatterWave } from "../client.js";
import { envValue } from "../client.js";
import type {
  MatterWavePiOptions,
  PiExtensionAPI,
  PiExtensionContext,
  PiExtensionFactory,
  PiModelDefinition,
  PiProviderConfig,
  PiToolCallEvent,
  PiToolCallResult,
} from "./types.js";

export const MATTERWAVE_PROVIDER_NAME = "matterwave";
export const PRESET_HEADER = "X-MatterWave-Preset-Id";
export const TEMPORARY_HEADER = "X-MatterWave-Temporary";
export const ORG_HEADER = "X-MatterWave-Org-Id";

/** Default MatterWave & GRT models used when `/v1/models` is unreachable or empty. */
export const DEFAULT_PI_MODELS: readonly PiModelDefinition[] = [
  {
    id: "grt-1",
    name: "MatterWave GRT-1 (Topological Reasoning)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10.0, cacheRead: 0.25, cacheWrite: 2.5 },
    contextWindow: 256_000,
    maxTokens: 32_768,
  },
  {
    id: "grt-1-mini",
    name: "MatterWave GRT-1 Mini (Fast Fermionic)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.4 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "matterwave-default",
    name: "MatterWave Default",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.0, output: 4.0, cacheRead: 0.1, cacheWrite: 1.0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "matterwave-coder",
    name: "MatterWave Coder",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.5, output: 6.0, cacheRead: 0.15, cacheWrite: 1.5 },
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
];

interface InternalClientFields {
  apiKey?: string | null;
  accessToken?: string | (() => string | Promise<string>) | null;
  defaultHeaders?: Record<string, string>;
}

/** Extract the bearer key or token configured on a `MatterWave` client instance. */
export async function resolveClientApiKey(client: MatterWave, explicitKey?: string): Promise<string> {
  if (explicitKey && explicitKey.trim() !== "") return explicitKey.trim();
  const internal = client as unknown as InternalClientFields;
  if (typeof internal.apiKey === "string" && internal.apiKey.trim() !== "") {
    return internal.apiKey.trim();
  }
  if (typeof internal.accessToken === "string" && internal.accessToken.trim() !== "") {
    return internal.accessToken.trim();
  }
  if (typeof internal.accessToken === "function") {
    const token = await internal.accessToken();
    if (typeof token === "string" && token.trim() !== "") return token.trim();
  }
  return envValue(API_KEY_ENV) ?? `$${API_KEY_ENV}`;
}

function mapGatewayModels(
  ids: readonly { id: string }[],
  fallbacks: readonly PiModelDefinition[],
): PiModelDefinition[] {
  const byId = new Map(fallbacks.map((m) => [m.id, m]));
  return ids.map((item) => {
    const known = byId.get(item.id);
    if (known) return { ...known, cost: { ...known.cost }, input: [...known.input] };
    return {
      id: item.id,
      name: item.id,
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
  });
}

/**
 * Construct the Pi 1.0 `ProviderConfig` for `pi.registerProvider("matterwave", ...)`.
 * Queries `client.models.list()` and falls back to `options.fallbackModels` (or
 * `DEFAULT_PI_MODELS`) on network or authentication errors.
 */
export async function buildPiProviderConfig(
  client: MatterWave,
  options: MatterWavePiOptions = {},
): Promise<PiProviderConfig> {
  const fallbacks = options.fallbackModels ?? DEFAULT_PI_MODELS;
  let models: PiModelDefinition[];
  try {
    const listed = await client.models.list();
    if (Array.isArray(listed?.data) && listed.data.length > 0) {
      models = mapGatewayModels(listed.data, fallbacks);
    } else {
      models = fallbacks.map((m) => ({ ...m, cost: { ...m.cost }, input: [...m.input] }));
    }
  } catch {
    models = fallbacks.map((m) => ({ ...m, cost: { ...m.cost }, input: [...m.input] }));
  }

  const internal = client as unknown as InternalClientFields;
  const headers: Record<string, string> = {
    ...(internal.defaultHeaders ?? {}),
    ...(options.headers ?? {}),
  };
  if (options.presetId !== undefined) {
    if (options.presetId.trim() !== "") headers[PRESET_HEADER] = options.presetId.trim();
    else delete headers[PRESET_HEADER];
  }
  if (options.temporary !== undefined) {
    if (options.temporary) headers[TEMPORARY_HEADER] = "true";
    else delete headers[TEMPORARY_HEADER];
  }
  if (options.orgId !== undefined) {
    if (options.orgId.trim() !== "") headers[ORG_HEADER] = options.orgId.trim();
    else delete headers[ORG_HEADER];
  }

  const apiKey = await resolveClientApiKey(client, options.apiKey);
  const base = client.baseUrl.replace(/\/+$/, "");

  return {
    name: "MatterWave",
    baseUrl: base.endsWith("/v1") ? base : `${base}/v1`,
    apiKey,
    api: "openai-completions",
    authHeader: true,
    headers,
    models,
  };
}

function candidatePathsFromInput(event: PiToolCallEvent): string[] {
  const input = event.input ?? {};
  const candidates: string[] = [];
  for (const key of ["path", "file_path", "filePath", "target", "directory", "dir", "file"]) {
    const val = input[key];
    if (typeof val === "string" && val.trim() !== "") {
      candidates.push(val.trim());
    }
  }
  if (
    (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === "run_shell") &&
    typeof input.command === "string"
  ) {
    const tokens = input.command
      .split(/[\s;|&><"'`]+/)
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("-"));
    candidates.push(...tokens);
  }
  return candidates;
}

/**
 * Create a Pi 1.0 extension function `(pi) => Promise<void>` that:
 * 1. Registers the `"matterwave"` provider with live/fallback models and MatterWave headers.
 * 2. Registers `/preset` and `/temporary` slash commands to switch presets or toggle temporary mode.
 * 3. Attaches a `tool_call` guardrail enforcing `agentAvailability` and `isDeniedPath` (`.env*`, `*.pem`, `id_*`, `.git/`).
 */
export function createMatterWavePiExtension(
  client: MatterWave,
  options: MatterWavePiOptions = {},
): PiExtensionFactory {
  let presetId = options.presetId;
  let temporary = options.temporary ?? false;
  const orgId = options.orgId;

  return async (pi: PiExtensionAPI): Promise<void> => {
    const refreshProvider = async (): Promise<PiProviderConfig> => {
      const config = await buildPiProviderConfig(client, {
        ...options,
        presetId,
        temporary,
        orgId,
      });
      pi.registerProvider(MATTERWAVE_PROVIDER_NAME, config);
      return config;
    };

    await refreshProvider();

    pi.registerCommand("preset", {
      description: "Set or clear the active MatterWave agent preset (/preset <id|off>)",
      handler: async (args: string, ctx: PiExtensionContext) => {
        const trimmed = args.trim();
        if (!trimmed || trimmed === "off" || trimmed === "none" || trimmed === "clear") {
          presetId = undefined;
          await refreshProvider();
          ctx?.ui?.setStatus?.("matterwave-preset", undefined);
          ctx?.ui?.notify?.("MatterWave preset cleared.", "info");
          return;
        }
        presetId = trimmed;
        await refreshProvider();
        ctx?.ui?.setStatus?.("matterwave-preset", `preset:${presetId}`);
        ctx?.ui?.notify?.(`MatterWave preset set to ${presetId}.`, "info");
      },
    });

    pi.registerCommand("temporary", {
      description: "Toggle MatterWave temporary session mode (/temporary [on|off])",
      handler: async (args: string, ctx: PiExtensionContext) => {
        const trimmed = args.trim().toLowerCase();
        if (trimmed === "on" || trimmed === "true" || trimmed === "1") {
          temporary = true;
        } else if (trimmed === "off" || trimmed === "false" || trimmed === "0") {
          temporary = false;
        } else {
          temporary = !temporary;
        }
        await refreshProvider();
        ctx?.ui?.setStatus?.("matterwave-temporary", temporary ? "temp:on" : undefined);
        ctx?.ui?.notify?.(`MatterWave temporary mode ${temporary ? "enabled" : "disabled"}.`, "info");
      },
    });

    pi.on("tool_call", (event: PiToolCallEvent, ctx?: PiExtensionContext): PiToolCallResult | undefined => {
      const availabilitySource =
        typeof options.availability === "function" ? options.availability() : options.availability;
      const trusted =
        availabilitySource?.trusted ?? (typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true);
      const check = agentAvailability({
        ...availabilitySource,
        trusted,
      });
      if (!check.available) {
        return {
          block: true,
          reason: check.reason ?? "Local agent tools are unavailable.",
        };
      }

      const root = options.root ?? ctx?.cwd;
      for (const candidate of candidatePathsFromInput(event)) {
        if (isDeniedPath(candidate, { deny: options.deny, root })) {
          return {
            block: true,
            reason: refusal("denied", { path: candidate }),
          };
        }
      }
      return undefined;
    });
  };
}
