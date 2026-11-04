/**
 * Unit tests for the `/api/v1/*` OIDC, OAuth, universal connector catalog,
 * decision trail, replay, checkpoint, reliability, telemetry, HITL,
 * guardrails, and tool planning client methods on `MatterWave`.
 */

import { describe, expect, it } from "vitest";
import { MatterWaveConfigError } from "../src/index.js";
import { BASE_URL, REQUEST_ID, client, json, stubFetch } from "./helpers.js";

function route(s: { method: string; url: string }): string {
  return `${s.method} ${s.url.slice(BASE_URL.length)}`;
}

describe("OIDC config, key sync, and claim enforcement", () => {
  it("fetches OIDC config, syncs an agent key, and enforces A2A claims", async () => {
    const { fetch, seen } = stubFetch([
      json({
        adapter: "zitadel",
        issuer_url: "https://auth.matterwave.test",
        token_endpoint: "https://auth.matterwave.test/oauth/v2/token",
        jwks_uri: "https://auth.matterwave.test/oauth/v2/keys",
        admin_url: "https://auth.matterwave.test/admin/v1",
        project_id: "proj-1",
        connected: true,
        status: "ready",
      }),
      json({
        key_id: "key-01",
        idp_client_id: "mw-agent-key-01@matterwave.local",
        oidc_issuer: "https://auth.matterwave.test",
        adapter: "zitadel",
        synced_at: "2026-11-01T10:00:00Z",
        scopes: ["openid", "urn:matterwave:org:acme"],
        resource_pattern: "org:acme/agents/*",
        a2a: {
          allowed_tools: ["Read", "Grep"],
          denied_tools: ["Bash"],
          allowed_models: ["claude-sonnet-4-6"],
          cwd_scope: "/workspace/app",
          limits: { max_tokens: 50000, max_duration_seconds: 600, max_cost_usd: 2.5 },
        },
      }),
      json({
        allowed: true,
        violation_claim: null,
        detail: "All A2A claims satisfied",
        effective_tools: ["Read"],
        resolved_cwd: "/workspace/app",
        limits: { max_tokens: 50000, max_duration_seconds: 600, max_cost_usd: 2.5 },
      }),
    ]);

    const mw = client(fetch, { maxRetries: 0 });
    const cfg = await mw.getOidcConfig();
    expect(cfg.adapter).toBe("zitadel");
    expect(cfg.connected).toBe(true);
    expect(cfg.requestId).toBe(REQUEST_ID);

    const synced = await mw.syncAgentKeyOidc("key-01");
    expect(synced.key_id).toBe("key-01");
    expect(synced.a2a.allowed_tools).toEqual(["Read", "Grep"]);

    const enforced = await mw.enforceOidcClaims({
      key_id: "key-01",
      requested_tools: ["Read"],
      requested_model: "claude-sonnet-4-6",
      requested_cwd: "/workspace/app",
    });
    expect(enforced.allowed).toBe(true);
    expect(enforced.effective_tools).toEqual(["Read"]);

    expect(seen.map(route)).toEqual([
      "GET /api/v1/oidc/config",
      "POST /api/v1/agent-keys/key-01/oidc-sync",
      "POST /api/v1/oidc/enforce-claims",
    ]);
    expect(seen[2]!.body).toMatchObject({ key_id: "key-01", requested_tools: ["Read"] });
  });
});

describe("universal connector catalog and OAuth broker", () => {
  it("lists the connector catalog, registers an OAuth authenticator, and proxies requests", async () => {
    const { fetch, seen } = stubFetch([
      json({
        data: [
          {
            provider_id: "github",
            name: "GitHub",
            category: "devtools",
            auth_types: ["oauth2"],
            authorize_url: "https://github.com/login/oauth/authorize",
            token_url: "https://github.com/login/oauth/access_token",
            api_base_url: "https://api.github.com",
            default_scopes: ["repo"],
            pkce_supported: true,
            refresh_supported: true,
            revoke_url: "https://api.github.com/applications/client_id/token",
            docs_url: "https://docs.github.com",
            icon: "github",
          },
        ],
        total: 1,
      }),
      json({
        authenticator_id: "auth-gh-01",
        name: "GitHub App",
        provider_id: "github",
        org_id: "acme",
        client_id: "Iv1.123456",
        client_secret_masked: "ghs_****",
        authorize_url: "https://github.com/login/oauth/authorize",
        token_url: "https://github.com/login/oauth/access_token",
        redirect_uri: "https://matterwave.test/api/v1/oauth/callback",
        scopes: ["repo"],
        api_base_url: "https://api.github.com",
        tenant_id: null,
        extra_authorize_params: {},
        created_at: "2026-11-01T10:00:00Z",
      }),
      json({
        credential_id: "cred-01",
        provider_id: "github",
        method: "POST",
        target_url: "https://api.github.com/repos/acme/app/issues",
        status_code: 201,
        auto_refreshed: false,
        broker: "fiberwise-credential-service",
        headers_injected: ["Authorization"],
        data: { id: 42, title: "Bug report" },
      }),
    ]);

    const mw = client(fetch, { maxRetries: 0 });
    const catalog = await mw.listConnectorCatalog("devtools", "git");
    expect(catalog.total).toBe(1);
    expect(catalog.data[0]!.provider_id).toBe("github");

    const auth = await mw.registerOAuthAuthenticator({
      name: "GitHub App",
      provider_id: "github",
      client_id: "Iv1.123456",
      client_secret: "secret-val",
      scopes: ["repo"],
    });
    expect(auth.authenticator_id).toBe("auth-gh-01");
    expect(auth.client_secret_masked).toBe("ghs_****");

    const proxied = await mw.proxyOAuthRequest("cred-01", "/repos/acme/app/issues", "post", {
      params: { state: "open" },
      headers: { "X-Custom": "1" },
      body: { title: "Bug report" },
      dryRun: true,
    });
    expect(proxied.status_code).toBe(201);
    expect(proxied.data).toEqual({ id: 42, title: "Bug report" });

    expect(seen.map(route)).toEqual([
      "GET /api/v1/connectors/catalog?category=devtools&q=git",
      "POST /api/v1/oauth/register",
      "POST /api/v1/oauth/proxy/cred-01",
    ]);
    expect(seen[2]!.body).toEqual({
      endpoint: "/repos/acme/app/issues",
      method: "POST",
      params: { state: "open" },
      headers: { "X-Custom": "1" },
      body: { title: "Bug report" },
      dry_run: true,
    });
  });
});

describe("decision trail, replay, checkpoints, and resume", () => {
  it("fetches decision trail, replays runs, lists checkpoints, and resumes runs", async () => {
    const { fetch, seen } = stubFetch([
      json({
        run_id: "run-123",
        org: "acme",
        nodes: [
          {
            id: "node-1",
            type: "tool_call",
            label: "Search codebase",
            step_id: "step-1",
            timestamp: "2026-11-01T10:00:00Z",
            duration_ms: 140,
            confidence: 0.95,
            tokens_used: 320,
            cost_usd: 0.002,
            outcome: "succeeded",
            rationale: "Locate handler definition",
            evidence: [{ file: "main.py" }],
            metadata: { tool: "Grep" },
          },
        ],
        edges: [{ from_node: "node-0", to_node: "node-1", edge_type: "sequential", label: "next" }],
        statistics: {
          total_nodes: 1,
          total_edges: 1,
          tool_calls_count: 1,
          total_tokens: 320,
          total_cost_usd: 0.002,
          duration_ms: 140,
          success: true,
        },
      }),
      json({
        replay_id: "rpl-01",
        run_id: "run-123",
        mode: "counterfactual",
        success: true,
        original_outcome: { status: "completed" },
        replayed_outcome: { status: "completed" },
        differences: [
          {
            step_id: "step-1",
            field: "model",
            original: "claude-sonnet-4-6",
            replayed: "claude-opus-4-6",
            significance: "minor",
          },
        ],
        duration_ms: 95,
        created_at: "2026-11-01T10:01:00Z",
      }),
      json({
        run_id: "run-123",
        data: [
          {
            checkpoint_id: "cp-01",
            thread_id: "thread-1",
            run_id: "run-123",
            step_id: "step-1",
            step_index: 0,
            timestamp: "2026-11-01T10:00:00Z",
            state: { cursor: 1 },
            metadata: { saver: "sql" },
            parent_checkpoint_id: null,
          },
        ],
      }),
      json({
        run_id: "run-456",
        source_run_id: "run-123",
        resumed_from_checkpoint_id: "cp-01",
        resumed_from_step: "step-1",
        state: "queued",
        restored_state: { cursor: 1, retry: true },
        created_at: "2026-11-01T10:02:00Z",
      }),
    ]);

    const mw = client(fetch, { maxRetries: 0 });
    const trail = await mw.getRunDecisionTrail("run-123");
    expect(trail.run_id).toBe("run-123");
    expect(trail.nodes[0]!.label).toBe("Search codebase");

    const replay = await mw.replayRun("run-123", "counterfactual", { model: "claude-opus-4-6" }, { fromStepId: "step-1" });
    expect(replay.replay_id).toBe("rpl-01");
    expect(replay.differences[0]!.field).toBe("model");

    const checkpoints = await mw.listRunCheckpoints("run-123");
    expect(checkpoints.data[0]!.checkpoint_id).toBe("cp-01");

    const resumed = await mw.resumeRun("run-123", "cp-01", { stateOverrides: { retry: true } });
    expect(resumed.run_id).toBe("run-456");

    expect(seen.map(route)).toEqual([
      "GET /api/v1/runs/run-123/decision-trail",
      "POST /api/v1/runs/run-123/replay",
      "GET /api/v1/runs/run-123/checkpoints",
      "POST /api/v1/runs/run-123/resume",
    ]);
    expect(seen[1]!.body).toEqual({
      mode: "counterfactual",
      overrides: { model: "claude-opus-4-6" },
      from_step_id: "step-1",
    });
    expect(seen[3]!.body).toEqual({
      checkpoint_id: "cp-01",
      state_overrides: { retry: true },
    });
  });
});

describe("reliability, telemetry, HITL, guardrails, and tool planning", () => {
  it("calls reliability, telemetry, HITL, guardrails, and tool plan endpoints", async () => {
    const { fetch, seen } = stubFetch([
      json({
        org: "acme",
        agent_id: "agent-1",
        sr: 0.98,
        cr: 0.96,
        pc: 0.99,
        hir: 0.02,
        ma: 0.97,
        tcl: 120.5,
        wct: 4500.0,
        total_runs: 50,
        window: "24h",
      }),
      json({
        org: "acme",
        mtte_p95_ms: 180.0,
        mtte_target_ms: 500.0,
        mtte_compliant: true,
        rsr: 0.995,
        rsr_target: 0.99,
        rsr_compliant: true,
        overall_compliant: true,
        total_measurements: 50,
        total_replays: 10,
      }),
      json({
        org: "acme",
        buckets: [
          {
            bucket: "2026-11-01T00:00:00Z",
            sr: 0.98,
            cr: 0.97,
            pc: 0.99,
            hir: 0.01,
            ma: 0.98,
            tcl: 110.0,
            wct: 4100.0,
            runs: 25,
          },
        ],
        anomalies: [],
      }),
      json({
        org: "acme",
        otel_enabled: true,
        prometheus_scraped: true,
        grafana_dashboards: ["agent-overview"],
        tempo_tracing_enabled: true,
        loki_logging_enabled: true,
        endpoints: [{ service: "prometheus", url: "http://prometheus:9090", healthy: true, protocol: "http" }],
      }),
      json({
        execution_id: "exec-99",
        pipeline_name: "code-review",
        status: "completed",
        total_duration_ms: 1240.5,
        total_tokens: 1500,
        total_cost_usd: 0.015,
        trace_id: "trace-abc",
        steps: [
          {
            step_id: "s1",
            step_name: "analyze",
            status: "completed",
            duration_ms: 1240.5,
            tokens_used: 1500,
            cost_usd: 0.015,
            retries: 0,
          },
        ],
      }),
      json({
        data: [
          {
            interaction_id: "hitl-01",
            execution_id: "exec-99",
            run_id: "run-123",
            step_id: "step-2",
            org: "acme",
            title: "Approve deployment",
            prompt: "Proceed with production rollout?",
            channels: ["web", "slack"],
            status: "pending",
            ui_schema: { type: "object" },
            context: { env: "prod" },
            decision: null,
            response_data: null,
            responded_by: null,
            created_at: "2026-11-01T10:00:00Z",
            responded_at: null,
          },
        ],
        total: 1,
      }),
      json({
        interaction_id: "hitl-01",
        execution_id: "exec-99",
        run_id: "run-123",
        step_id: "step-2",
        org: "acme",
        title: "Approve deployment",
        prompt: "Proceed with production rollout?",
        channels: ["web", "slack"],
        status: "approved",
        ui_schema: { type: "object" },
        context: { env: "prod" },
        decision: "approved",
        response_data: { note: "LGTM" },
        responded_by: "alice@acme.test",
        created_at: "2026-11-01T10:00:00Z",
        responded_at: "2026-11-01T10:05:00Z",
      }),
      json({
        rail_type: "input",
        action: "allow",
        allowed: true,
        modified_content: "Summarize the quarterly report",
        refusal_message: null,
        triggered_rails: [],
        violations: [],
      }),
      json({
        plan_id: "plan-01",
        task: "Find and fix lint errors",
        steps: [
          {
            step_id: "step_1",
            tool_name: "Grep",
            description: "Locate lint issues",
            arguments: { pattern: "TODO" },
            depends_on: [],
            estimated_cost_usd: 0.001,
            estimated_time_ms: 200,
            fallback_tool: "Read",
          },
        ],
        execution_order: [["step_1"]],
        total_estimated_cost_usd: 0.001,
        total_estimated_time_ms: 200,
        confidence: 0.92,
      }),
    ]);

    const mw = client(fetch, { maxRetries: 0 });
    const metrics = await mw.getReliabilityMetrics("agent-1");
    expect(metrics.sr).toBe(0.98);

    const slo = await mw.getReliabilitySlo();
    expect(slo.overall_compliant).toBe(true);

    const trends = await mw.getReliabilityTrends();
    expect(trends.buckets).toHaveLength(1);

    const telStatus = await mw.getTelemetryStatus();
    expect(telStatus.otel_enabled).toBe(true);

    const execTel = await mw.getExecutionTelemetry("exec-99");
    expect(execTel.execution_id).toBe("exec-99");

    const hitlList = await mw.listHitlInteractions({ status: "pending" });
    expect(hitlList.total).toBe(1);

    const hitlResolved = await mw.respondHitlInteraction("hitl-01", "approved", {
      responseData: { note: "LGTM" },
      respondedBy: "alice@acme.test",
    });
    expect(hitlResolved.decision).toBe("approved");

    const guard = await mw.evaluateGuardrails("input", "Summarize the quarterly report", {
      policies: ["pii_redaction"],
    });
    expect(guard.allowed).toBe(true);

    const plan = await mw.planTools("Find and fix lint errors", ["Grep", "Read", "Edit"]);
    expect(plan.plan_id).toBe("plan-01");

    expect(seen.map(route)).toEqual([
      "GET /api/v1/reliability/metrics?agent_id=agent-1",
      "GET /api/v1/reliability/slo",
      "GET /api/v1/reliability/trends",
      "GET /api/v1/telemetry/status",
      "GET /api/v1/telemetry/executions/exec-99/metrics",
      "GET /api/v1/hitl/interactions?status=pending",
      "POST /api/v1/hitl/interactions/hitl-01/respond",
      "POST /api/v1/guardrails/evaluate",
      "POST /api/v1/tools/plan",
    ]);
    expect(seen[7]!.body).toEqual({
      rail_type: "input",
      content: "Summarize the quarterly report",
      policies: ["pii_redaction"],
    });
    expect(seen[8]!.body).toEqual({
      task: "Find and fix lint errors",
      goal: "Find and fix lint errors",
      available_tools: ["Grep", "Read", "Edit"],
    });
  });

  it("rejects invalid path segments and blank required arguments", () => {
    const { fetch } = stubFetch([]);
    const mw = client(fetch, { maxRetries: 0 });
    expect(() => mw.syncAgentKeyOidc("bad/id")).toThrow(MatterWaveConfigError);
    expect(() => mw.enforceOidcClaims({})).toThrow(MatterWaveConfigError);
    expect(() => mw.registerOAuthAuthenticator({} as never)).toThrow(MatterWaveConfigError);
    expect(() => mw.proxyOAuthRequest("cred-1", "   ")).toThrow(MatterWaveConfigError);
    expect(() => mw.evaluateGuardrails("", "hello")).toThrow(MatterWaveConfigError);
    expect(() => mw.planTools("   ")).toThrow(MatterWaveConfigError);
  });
});
