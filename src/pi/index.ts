/**
 * `@matterwave/sdk/pi`: First-class Pi 1.0 (`@earendil-works/pi-coding-agent`)
 * provider config builder, extension factory, and JSON-Lines (`--mode rpc`)
 * client.
 *
 * @module @matterwave/sdk/pi
 */

export type {
  MatterWavePiOptions,
  PiCommandOptions,
  PiExtensionAPI,
  PiExtensionContext,
  PiExtensionFactory,
  PiExtensionUI,
  PiModelCost,
  PiModelDefinition,
  PiNamespace,
  PiOAuthCredentials,
  PiOAuthLoginCallbacks,
  PiProviderConfig,
  PiProviderOAuthConfig,
  PiRpcAssistantMessageDelta,
  PiRpcCommand,
  PiRpcCommandType,
  PiRpcEvent,
  PiRpcResponseEvent,
  PiRpcSessionState,
  PiToolCallEvent,
  PiToolCallResult,
} from "./types.js";
export {
  DEFAULT_PI_MODELS,
  MATTERWAVE_PROVIDER_NAME,
  ORG_HEADER,
  PRESET_HEADER,
  TEMPORARY_HEADER,
  buildPiProviderConfig,
  createMatterWavePiExtension,
  resolveClientApiKey,
} from "./provider.js";
export { PiRpcClient } from "./rpc.js";
export type { PiRpcClientOptions } from "./rpc.js";
export { agentAvailability, isDeniedPath } from "../agent/index.js";
export type { AgentAvailability, AgentAvailabilityInput } from "../agent/index.js";
