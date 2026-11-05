/**
 * Wire types and request parameters for the platform `/api/v1/*` OIDC, OAuth,
 * universal connector catalog, decision trail, replay, checkpoint,
 * reliability, telemetry, HITL, guardrails, and tool planning routes.
 */

import type { RequestOptions } from "./client.js";

// --- OIDC & A2A permissions ---------------------------------------------------

/** `GET /api/v1/oidc/config`: the deployment's OIDC identity provider configuration. */
export interface OidcConfig {
  adapter: string;
  issuer_url: string;
  token_endpoint: string;
  jwks_uri: string;
  admin_url: string;
  project_id: string;
  connected: boolean;
  status: string;
}

/** Execution bounds carried in an agent's A2A permission envelope. */
export interface A2ALimits {
  max_tokens: number;
  max_duration_seconds: number;
  max_cost_usd: number;
}

/** Agent-to-agent permission claims provisioned for an agent key. */
export interface A2APermissionEnvelope {
  allowed_tools: string[];
  denied_tools: string[];
  allowed_models: string[];
  cwd_scope: string;
  limits: A2ALimits;
}

/** `POST /api/v1/agent-keys/{key_id}/oidc-sync`: synchronized OIDC client binding and A2A claims. */
export interface OidcSyncResult {
  key_id: string;
  idp_client_id: string;
  oidc_issuer: string;
  adapter: string;
  synced_at: string;
  scopes: string[];
  resource_pattern: string;
  a2a: A2APermissionEnvelope;
}

export interface EnforceOidcClaimsParams {
  key_id?: string;
  claims?: Record<string, unknown>;
  requested_tools?: string[];
  requested_model?: string;
  requested_cwd?: string;
  estimated_tokens?: number;
  estimated_duration_seconds?: number;
  estimated_cost_usd?: number;
  [key: string]: unknown;
}

/** `POST /api/v1/oidc/enforce-claims`: decision and effective bounds after evaluating A2A claims. */
export interface EnforceClaimsResult {
  allowed: boolean;
  violation_claim: string | null;
  detail: string;
  effective_tools: string[];
  resolved_cwd: string;
  limits: A2ALimits;
}

// --- Universal connector catalog & OAuth broker -------------------------------

/** One provider in the universal connector catalog. */
export interface ConnectorCatalogEntry {
  provider_id: string;
  name: string;
  category: string;
  auth_types: string[];
  authorize_url: string;
  token_url: string;
  api_base_url: string;
  default_scopes: string[];
  pkce_supported: boolean;
  refresh_supported: boolean;
  revoke_url: string;
  docs_url: string;
  icon: string;
}

/** `GET /api/v1/connectors/catalog`: matching connector catalog entries and total count. */
export interface ConnectorCatalogList {
  data: ConnectorCatalogEntry[];
  total: number;
}

export interface ListConnectorCatalogParams extends RequestOptions {
  category?: string;
  q?: string;
}

export interface RegisterOAuthAuthenticatorParams {
  name: string;
  provider_id: string;
  client_id: string;
  client_secret?: string;
  authorize_url?: string;
  token_url?: string;
  redirect_uri?: string;
  scopes?: string[];
  api_base_url?: string;
  tenant_id?: string | null;
  extra_authorize_params?: Record<string, string>;
  [key: string]: unknown;
}

/** `POST /api/v1/oauth/register`: a registered OAuth authenticator with its client secret masked. */
export interface OAuthAuthenticator {
  authenticator_id: string;
  name: string;
  provider_id: string;
  org_id: string;
  client_id: string;
  client_secret_masked: string;
  authorize_url: string;
  token_url: string;
  redirect_uri: string;
  scopes: string[];
  api_base_url: string;
  tenant_id: string | null;
  extra_authorize_params: Record<string, string>;
  created_at: string;
}

export interface ProxyOAuthRequestOptions extends RequestOptions {
  method?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  dryRun?: boolean;
  dry_run?: boolean;
}

/** `POST /api/v1/oauth/proxy/{credential_id}`: proxied outbound request response. */
export interface CredentialProxyResponse {
  credential_id: string;
  provider_id: string;
  method: string;
  target_url: string;
  status_code: number;
  auto_refreshed: boolean;
  broker: string;
  headers_injected: string[];
  data: Record<string, unknown>;
}

// --- Decision trail, replay & checkpoints -------------------------------------

/** One node in a run's execution decision graph. */
export interface DecisionNode {
  id: string;
  type: string;
  label: string;
  step_id: string;
  timestamp: string;
  duration_ms: number;
  confidence: number;
  tokens_used: number;
  cost_usd: number;
  outcome: string;
  rationale: string;
  evidence: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}

/** A directed edge between two nodes in a run's decision graph. */
export interface DecisionEdge {
  from_node: string;
  to_node: string;
  edge_type: string;
  label: string;
}

/** Aggregate statistics across a run's decision trail. */
export interface DecisionTrailStatistics {
  total_nodes: number;
  total_edges: number;
  tool_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  success: boolean;
}

/** `GET /api/v1/runs/{run_id}/decision-trail`: complete decision trail graph and statistics. */
export interface DecisionTrail {
  run_id: string;
  org: string;
  nodes: DecisionNode[];
  edges: DecisionEdge[];
  statistics: DecisionTrailStatistics;
}

export type ReplayMode = "strict" | "simulated" | "counterfactual" | (string & {});

export interface ReplayRunOptions extends RequestOptions {
  mode?: ReplayMode;
  overrides?: Record<string, unknown>;
  fromStepId?: string;
  from_step_id?: string;
}

/** One field-level difference between the original run and a replay. */
export interface ReplayDifference {
  step_id: string;
  field: string;
  original: unknown;
  replayed: unknown;
  significance: string;
}

/** `POST /api/v1/runs/{run_id}/replay`: outcome and diff report from replaying a run. */
export interface ReplayRunResult {
  replay_id: string;
  run_id: string;
  mode: string;
  success: boolean;
  original_outcome: Record<string, unknown>;
  replayed_outcome: Record<string, unknown>;
  differences: ReplayDifference[];
  duration_ms: number;
  created_at: string;
}

/** One persisted execution checkpoint for a run. */
export interface CheckpointRecord {
  checkpoint_id: string;
  thread_id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  timestamp: string;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  parent_checkpoint_id: string | null;
}

/** `GET /api/v1/runs/{run_id}/checkpoints`: checkpoints recorded for a run. */
export interface CheckpointList {
  run_id: string;
  data: CheckpointRecord[];
}

export interface ResumeRunOptions extends RequestOptions {
  stateOverrides?: Record<string, unknown>;
  state_overrides?: Record<string, unknown>;
}

/** `POST /api/v1/runs/{run_id}/resume`: new run spawned from a checkpoint. */
export interface ResumeRunResult {
  run_id: string;
  source_run_id: string;
  resumed_from_checkpoint_id: string;
  resumed_from_step: string;
  state: string;
  restored_state: Record<string, unknown>;
  created_at: string;
}

// --- Reliability, telemetry, HITL, guardrails & tool planning -----------------

export interface GetReliabilityMetricsOptions extends RequestOptions {
  agentId?: string;
  agent_id?: string;
}

/** `GET /api/v1/reliability/metrics`: aggregate reliability indicators. */
export interface ReliabilityMetrics {
  org: string;
  agent_id: string | null;
  sr: number;
  cr: number;
  pc: number;
  hir: number;
  ma: number;
  tcl: number;
  wct: number;
  total_runs: number;
  window: string;
}

/** `GET /api/v1/reliability/slo`: service-level objective compliance report. */
export interface ReliabilitySloReport {
  org: string;
  mtte_p95_ms: number;
  mtte_target_ms: number;
  mtte_compliant: boolean;
  rsr: number;
  rsr_target: number;
  rsr_compliant: boolean;
  overall_compliant: boolean;
  total_measurements: number;
  total_replays: number;
}

/** An anomaly detected across reliability metric trends. */
export interface AnomalyAlert {
  metric: string;
  severity: string;
  current_value: number;
  baseline_value: number;
  threshold: number;
  message: string;
  detected_at: string;
}

/** One time-bucketed slice of reliability metrics. */
export interface ReliabilityTrendBucket {
  bucket: string;
  sr: number;
  cr: number;
  pc: number;
  hir: number;
  ma: number;
  tcl: number;
  wct: number;
  runs: number;
}

/** `GET /api/v1/reliability/trends`: historical reliability buckets and detected anomalies. */
export interface ReliabilityTrends {
  org: string;
  buckets: ReliabilityTrendBucket[];
  anomalies: AnomalyAlert[];
}

/** One endpoint in the platform's observability stack. */
export interface TelemetryServiceEndpoint {
  service: string;
  url: string;
  healthy: boolean;
  protocol: string;
}

/** `GET /api/v1/telemetry/status`: status of the OpenTelemetry, Prometheus, Grafana, Tempo, and Loki stack. */
export interface TelemetryStackStatus {
  org: string;
  otel_enabled: boolean;
  prometheus_scraped: boolean;
  grafana_dashboards: string[];
  tempo_tracing_enabled: boolean;
  loki_logging_enabled: boolean;
  endpoints: TelemetryServiceEndpoint[];
}

/** Telemetry metrics for a single step within an execution. */
export interface StepTelemetryMetrics {
  step_id: string;
  step_name: string;
  status: string;
  duration_ms: number;
  tokens_used: number;
  cost_usd: number;
  retries: number;
}

/** `GET /api/v1/telemetry/executions/{execution_id}/metrics`: per-step and total telemetry metrics. */
export interface TelemetryExecutionMetrics {
  execution_id: string;
  pipeline_name: string;
  status: string;
  total_duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  trace_id: string;
  steps: StepTelemetryMetrics[];
}

/** One human-in-the-loop interaction request and its resolution state. */
export interface HitlInteraction {
  interaction_id: string;
  execution_id: string;
  run_id: string;
  step_id: string;
  org: string;
  title: string;
  prompt: string;
  channels: string[];
  status: string;
  ui_schema: Record<string, unknown>;
  context: Record<string, unknown>;
  decision: string | null;
  response_data: Record<string, unknown> | null;
  responded_by: string | null;
  created_at: string;
  responded_at: string | null;
}

/** `GET /api/v1/hitl/interactions`: human-in-the-loop interactions for the organisation. */
export interface HitlInteractionList {
  data: HitlInteraction[];
  total: number;
}

export interface ListHitlInteractionsOptions extends RequestOptions {
  status?: string;
}

export interface RespondHitlInteractionOptions extends RequestOptions {
  responseData?: Record<string, unknown>;
  response_data?: Record<string, unknown>;
  respondedBy?: string;
  responded_by?: string;
}

export type GuardrailType = "input" | "dialog" | "retrieval" | "execution" | "output" | (string & {});

export interface EvaluateGuardrailsOptions extends RequestOptions {
  toolName?: string;
  tool_name?: string;
  toolArgs?: Record<string, unknown>;
  tool_args?: Record<string, unknown>;
  policies?: string[];
}

/** One guardrail violation triggered during content evaluation. */
export interface GuardrailViolation {
  rail_id: string;
  rail_type: string;
  category: string;
  severity: string;
  message: string;
  matched_text: string | null;
}

/** `POST /api/v1/guardrails/evaluate`: verdict, modified content, and triggered violations. */
export interface GuardrailEvaluation {
  rail_type: string;
  action: string;
  allowed: boolean;
  modified_content: string;
  refusal_message: string | null;
  triggered_rails: string[];
  violations: GuardrailViolation[];
}

export interface PlanToolsOptions extends RequestOptions {
  constraints?: Record<string, unknown>;
}

/** One planned tool invocation step with dependencies and cost/time estimates. */
export interface ToolPlanStep {
  step_id: string;
  tool_name: string;
  description: string;
  arguments: Record<string, unknown>;
  depends_on: string[];
  estimated_cost_usd: number;
  estimated_time_ms: number;
  fallback_tool: string | null;
}

/** `POST /api/v1/tools/plan`: execution plan of tool calls ordered into parallelizable stages. */
export interface ToolPlan {
  plan_id: string;
  task: string;
  steps: ToolPlanStep[];
  execution_order: string[][];
  total_estimated_cost_usd: number;
  total_estimated_time_ms: number;
  confidence: number;
}

export const GRT_WHITEPAPER_SHA256 =
  "79219257df919cc598a75f7ae0968988ed0d33ffc1777469f9a9da39a558819d";

export interface GrtHfModelSpec {
  id: string;
  alias: string;
  name: string;
  hf_repo_id: string;
  hf_url: string;
  path: string;
  architecture: string;
  model_type: string;
  pipeline_tag: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  vocab_size: number;
  hidden_size: number;
  context_window: number;
  weight_sha256: string | null;
  config_sha256: string;
  whitepaper_sha256: string;
}

/**
 * Official 9-model `MatterWaveAI/grt-30m*` HuggingFace suite catalog with verified SHA256 digests.
 */
export const GRT_HF_MODELS: readonly GrtHfModelSpec[] = [
  {
    id: "MatterWaveAI/grt-30m",
    alias: "grt-30m",
    name: "MatterWave GRT-30M (Base Causal LM)",
    hf_repo_id: "MatterWaveAI/grt-30m",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m",
    path: "release/30m",
    architecture: "GRTForCausalLM",
    model_type: "grt",
    pipeline_tag: "text-generation",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "205f76f3ed59fee0ed54bb8133ea1b1a64527994c68776066057b4707f1b2456",
    config_sha256: "5ffa4facb3cfba2b39512bbc54c7b7ecda637c70f40fd18ede13396cd8e5a86b",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-chat",
    alias: "grt-30m-chat",
    name: "MatterWave GRT-30M Chat (Instruction & Tool Tuned)",
    hf_repo_id: "MatterWaveAI/grt-30m-chat",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-chat",
    path: "release/30m-chat",
    architecture: "GRTForCausalLM",
    model_type: "grt",
    pipeline_tag: "text-generation",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "ee613803cb7b2c618def7e6c79476e1aab4e887cc08e234204b6bad12ad772bc",
    config_sha256: "c2b264a05e11914a8e41c1610f3c81e15d38151c459a1c66caaaa0381d804685",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-mor",
    alias: "grt-30m-mor",
    name: "MatterWave GRT-30M MoR (Mixture-of-Recursions)",
    hf_repo_id: "MatterWaveAI/grt-30m-mor",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-mor",
    path: "release/30m-mor",
    architecture: "GRTForCausalLM",
    model_type: "grt",
    pipeline_tag: "text-generation",
    input: ["text"],
    reasoning: true,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "5633a578073e808d18fe3e52fb0fbf0005dc015b6bb10a1bff339f5d83225a07",
    config_sha256: "bf652df2d4107c7e7ef3c23d0854436aedb0030f0821f97939ed6ed858254013",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-embedding",
    alias: "grt-30m-embedding",
    name: "MatterWave GRT-30M Embedding (Dense Vector Encoder)",
    hf_repo_id: "MatterWaveAI/grt-30m-embedding",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-embedding",
    path: "release/30m-embedding",
    architecture: "GRTModel",
    model_type: "grt",
    pipeline_tag: "feature-extraction",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "5cdab387c5e2ee9bb3907acaccfccfaa7cc10060c21e3f265ce981a4a7d38226",
    config_sha256: "c987cec1b71deba4a1749a939032309921872ae2a6c21378f8160edb29b210df",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-reranker",
    alias: "grt-30m-reranker",
    name: "MatterWave GRT-30M Reranker (Cross-Encoder Reranking)",
    hf_repo_id: "MatterWaveAI/grt-30m-reranker",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-reranker",
    path: "release/30m-reranker",
    architecture: "GRTForSequenceClassification",
    model_type: "grt",
    pipeline_tag: "text-classification",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "6d090decc4426a1c21a372c1bd718a6b80626e2c7b460c9ab79b713d84320ef9",
    config_sha256: "6f401b7ed6af93ed7fc93eedc6de44ad67f2f19ecdc5b3c96dcc92ee564750fc",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-vl",
    alias: "grt-30m-vl",
    name: "MatterWave GRT-30M Vision-Language (Multimodal VL)",
    hf_repo_id: "MatterWaveAI/grt-30m-vl",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-vl",
    path: "release/30m-vl",
    architecture: "GRTVLForConditionalGeneration",
    model_type: "grt_vl",
    pipeline_tag: "image-text-to-text",
    input: ["text", "image"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "b21667c9d39c67513671af4fe4480551f26ac738b23821902fd78ae55a4f1dfe",
    config_sha256: "0fd2f34d415723412d54055ecb174bcbb60cccaf43235af52b6c13826e6bb859",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-tts",
    alias: "grt-30m-tts",
    name: "MatterWave GRT-30M TTS (Neural Speech Synthesis)",
    hf_repo_id: "MatterWaveAI/grt-30m-tts",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tts",
    path: "release/30m-tts",
    architecture: "GRTTTSForConditionalGeneration",
    model_type: "grt_tts",
    pipeline_tag: "text-to-speech",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "9df117cf2d9fdd14a972495293628bfea4ab503ee4fbcb270ffb667763e314f4",
    config_sha256: "74dca6d26f2726ae96033446d5d418a152aef8368a8e49aa49bb15f6364ca75a",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-omni",
    alias: "grt-30m-omni",
    name: "MatterWave GRT-30M Omni (Any-to-Any Multimodal)",
    hf_repo_id: "MatterWaveAI/grt-30m-omni",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-omni",
    path: "release/30m-omni",
    architecture: "GRTOmniForConditionalGeneration",
    model_type: "grt_omni",
    pipeline_tag: "any-to-any",
    input: ["text", "image"],
    reasoning: true,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: "b314996ce883a0c875de18da67f5d23103c507c79b7421b8b8c52cef95d2fbf7",
    config_sha256: "5bc88f708534280522872f046e89deade537f286a78bc261c1e039d03fa6d0cf",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
  {
    id: "MatterWaveAI/grt-30m-tokenizer",
    alias: "grt-30m-tokenizer",
    name: "MatterWave GRT-30M Tokenizer (151,669-Token Vocabulary)",
    hf_repo_id: "MatterWaveAI/grt-30m-tokenizer",
    hf_url: "https://huggingface.co/MatterWaveAI/grt-30m-tokenizer",
    path: "release/30m-tokenizer",
    architecture: "GRTTokenizer",
    model_type: "grt",
    pipeline_tag: "feature-extraction",
    input: ["text"],
    reasoning: false,
    vocab_size: 151669,
    hidden_size: 256,
    context_window: 2048,
    weight_sha256: null,
    config_sha256: "4c7ed24fcbaf5b1c62ec160296e682eb7b700ea19d88f0a8e01e363b125d505f",
    whitepaper_sha256: GRT_WHITEPAPER_SHA256,
  },
] as const;

export interface RerankOptions extends RequestOptions {
  model?: string;
  topN?: number;
  top_n?: number;
  returnDocuments?: boolean;
  return_documents?: boolean;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string } | string | null;
}

export interface RerankResponse {
  id?: string;
  model: string;
  results: RerankResult[];
  usage?: Record<string, number>;
}

export interface SynthesizeSpeechOptions extends RequestOptions {
  model?: string;
  voice?: string;
  responseFormat?: string;
  response_format?: string;
  speed?: number;
}

export interface SpeechSynthesisResponse {
  id?: string;
  model: string;
  voice: string;
  format: string;
  sample_rate: number;
  duration_ms?: number;
  audio_base64: string;
  phoneme_tokens?: number[];
}

export interface GrtSuiteManifest {
  suite?: string;
  organization?: string;
  whitepaper_sha256?: string;
  total?: number;
  models: Array<GrtHfModelSpec | Record<string, unknown>>;
}
