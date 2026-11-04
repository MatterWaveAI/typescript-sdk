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
