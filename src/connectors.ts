/**
 * The org's agent presets and its connectors: `presets`, and `connections`
 * with `connections.routes`, `connections.identities` and
 * `connections.events`, one method per route on top of the client's request
 * and retry loop.
 *
 *     const { data } = await client.presets.list();
 *     const conversation = await client.conversations.create({ preset_id: data[0]!.id });
 *
 * A preset is a name, a model, instructions, tools and a welcome message
 * that a conversation answers with and that a connector's channel is routed
 * to. Any member reads the presets -- an API key with `chat:read`, so a
 * terminal's picker can offer them -- and an owner or admin writes them, a
 * key with `presets:manage` whose owner is one.
 *
 * A connection joins the org to an outside workspace (Slack's): events come
 * in at its ingress URL, signed by the provider, and the channels it is
 * routed to are answered with a preset at a member's expense. Connecting a
 * workspace is a person's decision, so these routes take no key scope at
 * all: they need a person's token (`accessToken`, `client.auth.person`) from
 * an owner or admin, and refuse every API key 403 "Membership is managed by
 * a person, not an API key." Credentials go in on `create` and `update`, are
 * checked with the provider there, and never come back out. A deployment
 * without connectors answers every connection route 503, thrown as
 * `ServerError` whose message names the setting to make
 * (`MW_CONNECTOR_SECRET_KEY`).
 */

import { MatterWaveConfigError } from "./client.js";
import type { MatterWave, RequestOptions } from "./client.js";
import type {
  Connection,
  ConnectionEvent,
  ConnectionEventPage,
  ConnectionIdentity,
  ConnectionIdentityList,
  ConnectionList,
  ConnectionRoute,
  ConnectionRouteList,
  CreateConnectionParams,
  CreateConnectionRouteParams,
  CreatePresetParams,
  ListConnectionEventsParams,
  ListConnectionIdentitiesParams,
  Preset,
  PresetListing,
  SlackManifest,
  UpdateConnectionParams,
  UpdateConnectionRouteParams,
  UpdatePresetParams,
} from "./connector-types.js";
import { itemsOf, pagesOf, query, segment } from "./conversations.js";
import { Resource, given, present } from "./native.js";
import type { WithRequestId } from "./types.js";

const PRESETS_PATH = "/api/org/presets";
const CONNECTIONS_PATH = "/api/org/connections";
const PRESET_FIELDS = ["name", "description", "model", "instructions", "tools", "welcome_message"] as const;
const CONNECTION_FIELDS = ["display_name", "status", "rate_limit_per_minute", "config", "credentials"] as const;
const ROUTE_FIELDS = ["channel_label", "preset_id", "paying_subject", "enabled"] as const;
// The states an admin may put a connection in; `pending`, `revoked` and
// `error` are the platform's and the provider's to set.
const CONNECTION_STATUSES = ["active", "disabled"];
const RATE_LIMIT_MAX = 10_000;
const EVENTS_LIMIT_MAX = 200;
// An instant that says its zone: `Z`, or an offset like `+02:00`.
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function required(name: string, value: string | undefined): void {
  if (!value?.trim()) throw new MatterWaveConfigError(`${name} must not be blank`);
}

function needsOne(body: Record<string, unknown>, fields: readonly string[]): void {
  if (!fields.some((field) => field in body)) throw new MatterWaveConfigError(`update needs one of ${fields.join(", ")}`);
}

// --- presets -------------------------------------------------------------------

function presetPath(presetId: string): string {
  return `${PRESETS_PATH}/${segment("presetId", presetId)}`;
}

/**
 * `/api/org/presets`: the org's agent presets. Any member reads them (a key
 * with `chat:read`); an owner or admin writes them (a key with
 * `presets:manage`).
 */
export class Presets extends Resource {
  /** The live presets, the tools a preset may name, the limits, and whether the caller may change them (`can_manage`). */
  list(options: RequestOptions = {}): Promise<WithRequestId<PresetListing>> {
    return this.call("GET", PRESETS_PATH, undefined, options);
  }

  /** One preset, a deleted one included (`deleted_at` says so). */
  get(presetId: string, options: RequestOptions = {}): Promise<WithRequestId<Preset>> {
    return this.call("GET", presetPath(presetId), undefined, options);
  }

  /**
   * A new preset. `tools` left out is the platform's default set and an empty
   * list none. The model is checked against the plan and the org's
   * allow-list (a 422 on `model`); a name the org already uses, ignoring case,
   * or one preset past the limit is a `ConflictError`.
   */
  create(params: CreatePresetParams, options: RequestOptions = {}): Promise<WithRequestId<Preset>> {
    required("name", params.name);
    required("model", params.model);
    return this.call("POST", PRESETS_PATH, present(params), options);
  }

  /**
   * Change what was given. `tools: null` goes back to the default set and
   * `welcome_message: null` drops the message; a field left out is left
   * alone. A deleted preset is a `NotFoundError`: it stays as its
   * conversations answer with it.
   */
  update(presetId: string, params: UpdatePresetParams, options: RequestOptions = {}): Promise<WithRequestId<Preset>> {
    const body = given(params);
    needsOne(body, PRESET_FIELDS);
    if ("name" in body) required("name", params.name);
    if ("model" in body) required("model", params.model);
    return this.call("PATCH", presetPath(presetId), body, options);
  }

  /** Soft: the conversations on it keep answering with it, and nobody is offered it again. */
  delete(presetId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", presetPath(presetId), options);
  }
}

// --- connections ---------------------------------------------------------------

function connectionPath(connectionId: string, suffix = ""): string {
  return `${CONNECTIONS_PATH}/${segment("connectionId", connectionId)}${suffix}`;
}

function checkRateLimit(value: number | undefined): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= 1 && value <= RATE_LIMIT_MAX)) {
    throw new MatterWaveConfigError(`rate_limit_per_minute must be 1 to ${RATE_LIMIT_MAX}, got ${value}`);
  }
}

function checkCredentials(credentials: Record<string, unknown> | undefined): void {
  if (credentials !== undefined && Object.keys(credentials).length === 0) {
    throw new MatterWaveConfigError("credentials must name at least one field");
  }
}

/** The connection as the client hands it back: whatever the answer carried, never the credentials. */
function withoutCredentials<T extends object>(value: T): T {
  if ("credentials" in value) delete (value as Record<string, unknown>).credentials;
  return value;
}

/**
 * `/api/org/connections/{id}/routes`: the channels a connection answers,
 * each with its preset and paying member. Owner or admin, with a person's
 * token.
 */
export class ConnectionRoutes extends Resource {
  list(connectionId: string, options: RequestOptions = {}): Promise<WithRequestId<ConnectionRouteList>> {
    return this.call("GET", connectionPath(connectionId, "/routes"), undefined, options);
  }

  /**
   * Answer `external_channel_id` with `preset_id`, charged to the member
   * `paying_subject`. A preset not the org's or a payer not a current member
   * is a 422; a channel that already has a route a `ConflictError`.
   */
  create(
    connectionId: string,
    params: CreateConnectionRouteParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectionRoute>> {
    required("external_channel_id", params.external_channel_id);
    required("preset_id", params.preset_id);
    required("paying_subject", params.paying_subject);
    return this.call("POST", connectionPath(connectionId, "/routes"), present(params), options);
  }

  update(
    connectionId: string,
    routeId: string,
    params: UpdateConnectionRouteParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectionRoute>> {
    const body = present(params);
    needsOne(body, ROUTE_FIELDS);
    const path = connectionPath(connectionId, `/routes/${segment("routeId", routeId)}`);
    return this.call("PATCH", path, body, options);
  }

  delete(connectionId: string, routeId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", connectionPath(connectionId, `/routes/${segment("routeId", routeId)}`), options);
  }
}

/**
 * `/api/org/connections/{id}/identities`: everyone a connection has heard
 * from, and which member each is. An admin's `map`, `unmap`, `block` or
 * `unblock` stands over the email match from then on. Owner or admin, with
 * a person's token.
 */
export class ConnectionIdentities extends Resource {
  /** Filtered to one status (`mapped`, `unmapped`, `guest`, `blocked`) when given. */
  list(
    connectionId: string,
    params: ListConnectionIdentitiesParams = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectionIdentityList>> {
    const path = connectionPath(connectionId, `/identities${query({ status: params.status })}`);
    return this.call("GET", path, undefined, options);
  }

  /** This identity is the member `subject`. */
  map(
    connectionId: string,
    identityId: string,
    subject: string,
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectionIdentity>> {
    required("subject", subject);
    return this.decide(connectionId, identityId, { action: "map", subject }, options);
  }

  unmap(connectionId: string, identityId: string, options: RequestOptions = {}): Promise<WithRequestId<ConnectionIdentity>> {
    return this.decide(connectionId, identityId, { action: "unmap" }, options);
  }

  /** Refuse this identity's messages. */
  block(connectionId: string, identityId: string, options: RequestOptions = {}): Promise<WithRequestId<ConnectionIdentity>> {
    return this.decide(connectionId, identityId, { action: "block" }, options);
  }

  unblock(connectionId: string, identityId: string, options: RequestOptions = {}): Promise<WithRequestId<ConnectionIdentity>> {
    return this.decide(connectionId, identityId, { action: "unblock" }, options);
  }

  /**
   * `GET /api/org/connector-identities`: the provider accounts mapped to one
   * member across every connection, each with its `connector` and
   * `connection_name`.
   */
  forMember(subject: string, options: RequestOptions = {}): Promise<WithRequestId<ConnectionIdentityList>> {
    required("subject", subject);
    return this.call("GET", `/api/org/connector-identities${query({ subject })}`, undefined, options);
  }

  private decide(
    connectionId: string,
    identityId: string,
    body: { action: string; subject?: string },
    options: RequestOptions,
  ): Promise<WithRequestId<ConnectionIdentity>> {
    const path = connectionPath(connectionId, `/identities/${segment("identityId", identityId)}`);
    return this.call("PATCH", path, body, options);
  }
}

/**
 * `/api/org/connections/{id}/events`: what a connection received and what
 * became of each event, newest first -- ids and outcomes, never what anyone
 * wrote. Owner or admin, with a person's token.
 */
export class ConnectionEvents extends Resource {
  /**
   * One page. `outcome` is one of `ConnectionList.outcomes`; `since` carries
   * its zone; `cursor` is a previous page's `next_cursor`; `limit` is 1 to
   * 200, 50 when omitted.
   */
  list(
    connectionId: string,
    params: ListConnectionEventsParams = {},
    options: RequestOptions = {},
  ): Promise<WithRequestId<ConnectionEventPage>> {
    if (params.limit !== undefined && !(params.limit >= 1 && params.limit <= EVENTS_LIMIT_MAX)) {
      throw new MatterWaveConfigError(`limit must be 1 to ${EVENTS_LIMIT_MAX}, got ${params.limit}`);
    }
    if (params.since !== undefined && !ZONED.test(params.since)) {
      throw new MatterWaveConfigError("since must carry a timezone");
    }
    const path = connectionPath(
      connectionId,
      `/events${query({ outcome: params.outcome, since: params.since, cursor: params.cursor, limit: params.limit })}`,
    );
    return this.call("GET", path, undefined, options);
  }

  /** Every page of `list` under the same filters, each fetched as the previous one is consumed. */
  pages(
    connectionId: string,
    params: Omit<ListConnectionEventsParams, "cursor"> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<WithRequestId<ConnectionEventPage>> {
    return pagesOf((cursor) => this.list(connectionId, { ...params, cursor }, options));
  }

  /** Every matching event, newest first, one at a time across the pages. */
  items(
    connectionId: string,
    params: Omit<ListConnectionEventsParams, "cursor"> = {},
    options: RequestOptions = {},
  ): AsyncGenerator<ConnectionEvent> {
    return itemsOf(this.pages(connectionId, params, options));
  }
}

/**
 * `/api/org/connections`: the org's connections to outside workspaces. Owner
 * or admin, with a person's token; an API key is refused 403 "Membership is
 * managed by a person, not an API key." Credentials go in and never come
 * out: no `Connection` carries them.
 */
export class Connections extends Resource {
  readonly routes: ConnectionRoutes;
  readonly identities: ConnectionIdentities;
  readonly events: ConnectionEvents;

  constructor(client: MatterWave) {
    super(client);
    this.routes = new ConnectionRoutes(client);
    this.identities = new ConnectionIdentities(client);
    this.events = new ConnectionEvents(client);
  }

  /** The connections, the connectors this deployment offers, and the vocabularies of notices, outcomes and identity statuses. */
  list(options: RequestOptions = {}): Promise<WithRequestId<ConnectionList>> {
    return this.call<ConnectionList>("GET", CONNECTIONS_PATH, undefined, options).then((listed) => {
      for (const connection of listed.data ?? []) withoutCredentials(connection);
      return listed;
    });
  }

  get(connectionId: string, options: RequestOptions = {}): Promise<WithRequestId<Connection>> {
    return this.call<Connection>("GET", connectionPath(connectionId), undefined, options).then(withoutCredentials);
  }

  /**
   * Connect a workspace through `connector` (one of
   * `ConnectionList.connectors`). The credentials are checked with the
   * provider first: refused is a 422 on `credentials`, unreachable a 502.
   * Without them the connection is `pending` -- for Slack, whose app is
   * built around the ingress URL (`slackManifest`) -- and an `update`
   * carrying them activates it.
   */
  create(params: CreateConnectionParams, options: RequestOptions = {}): Promise<WithRequestId<Connection>> {
    required("connector", params.connector);
    required("display_name", params.display_name);
    checkCredentials(params.credentials);
    checkRateLimit(params.rate_limit_per_minute);
    return this.call<Connection>("POST", CONNECTIONS_PATH, present(params), options).then(withoutCredentials);
  }

  /**
   * Change what was given. `status` switches a connection `active` or
   * `disabled`; new `credentials` are checked with the provider, as on
   * `create`, and activate a pending connection.
   */
  update(
    connectionId: string,
    params: UpdateConnectionParams,
    options: RequestOptions = {},
  ): Promise<WithRequestId<Connection>> {
    const body = present(params);
    needsOne(body, CONNECTION_FIELDS);
    if ("display_name" in body) required("display_name", params.display_name);
    if (params.status !== undefined && !CONNECTION_STATUSES.includes(params.status)) {
      throw new MatterWaveConfigError(`status must be one of ${CONNECTION_STATUSES.join(", ")}, got ${params.status}`);
    }
    checkCredentials(params.credentials);
    checkRateLimit(params.rate_limit_per_minute);
    return this.call<Connection>("PATCH", connectionPath(connectionId), body, options).then(withoutCredentials);
  }

  /** The connection with its routes, identities and log. The conversations it opened stay with their paying members. */
  delete(connectionId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", connectionPath(connectionId), options);
  }

  /** A new ingress URL; the old one stops routing now. */
  rotateUrl(connectionId: string, options: RequestOptions = {}): Promise<WithRequestId<Connection>> {
    return this.call<Connection>("POST", connectionPath(connectionId, "/rotate-url"), undefined, options).then(
      withoutCredentials,
    );
  }

  /**
   * The Slack app manifest for a Slack connection, written around its
   * ingress URL, and the link that creates the app from it. Any other
   * connection is a `NotFoundError`.
   */
  slackManifest(connectionId: string, options: RequestOptions = {}): Promise<WithRequestId<SlackManifest>> {
    required("connectionId", connectionId);
    return this.call("GET", `${CONNECTIONS_PATH}/slack/manifest${query({ connection_id: connectionId })}`, undefined, options);
  }
}
