/**
 * The wire types of the preset and connection routes, spelled as the API
 * spells them: the org's agent presets, its connections to outside
 * workspaces (Slack's), the channels each connection answers, the people it
 * has heard from, and its event log.
 *
 * No type here has a field for a connection's credentials: they go in on
 * `connections.create` and `connections.update` and the API never sends
 * them back, and the client drops them from an answer that carried them.
 */

// --- presets -------------------------------------------------------------------

/**
 * One of the org's agent presets: the model, instructions, tools and welcome
 * message a conversation on it answers with. `tools` null is the platform's
 * default set and an empty list none. `deleted_at` is set on a deleted one,
 * which `presets.get` still answers for -- a conversation on it keeps
 * answering with it -- and the list never offers.
 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  model: string;
  instructions: string;
  tools: string[] | null;
  welcome_message: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A tool a preset may name, with what it does. */
export interface PresetTool {
  name: string;
  description: string;
}

/** The rules a preset is held to: how many the org may keep, and the longest name, description, instructions and welcome message. */
export interface PresetLimits {
  max_presets: number;
  name_max_len: number;
  description_max_len: number;
  instructions_max_len: number;
  welcome_max_len: number;
}

/**
 * `GET /api/org/presets`: the org's live presets, the tools a preset may
 * name, the limits, and `can_manage`, whether the caller may change them (an
 * owner or admin).
 */
export interface PresetListing {
  data: Preset[];
  tools: PresetTool[];
  limits: PresetLimits;
  can_manage: boolean;
}

export interface CreatePresetParams {
  name: string;
  /** Checked against the plan and the org's allow-list: a 422 on `model` when neither allows it. */
  model: string;
  description?: string;
  instructions?: string;
  /** Left out (or null) is the platform's default set; an empty list is none. */
  tools?: string[] | null;
  welcome_message?: string | null;
}

/** Every field optional; one left out is unchanged. */
export interface UpdatePresetParams {
  name?: string;
  description?: string;
  model?: string;
  instructions?: string;
  /** `null` goes back to the platform's default set. */
  tools?: string[] | null;
  /** `null` drops the message. */
  welcome_message?: string | null;
}

// --- connections ---------------------------------------------------------------

/**
 * `pending` (made without credentials, waiting for them), `active`,
 * `disabled`, `revoked` (the workspace uninstalled the app) or `error` (the
 * provider refused the credentials).
 */
export type ConnectionStatus = "pending" | "active" | "disabled" | "revoked" | "error" | (string & {});

/**
 * One connection to an outside workspace. `ingress_url` is where the
 * provider posts its events; `connections.rotateUrl` replaces it. Never the
 * credentials.
 */
export interface Connection {
  id: string;
  connector: string;
  display_name: string;
  status: ConnectionStatus;
  ingress_url: string;
  config: Record<string, unknown>;
  external_workspace_id: string | null;
  rate_limit_per_minute: number;
  installed_by: string;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/org/connections`: the org's connections, the connectors this
 * deployment can make one with, and the vocabularies a settings pane offers
 * -- the events a connection may be notified of (`config.notify_events`),
 * the outcomes the event log filters on, and the identity statuses.
 */
export interface ConnectionList {
  data: Connection[];
  connectors: string[];
  notifiable_events: string[];
  outcomes: string[];
  identity_statuses: string[];
}

export interface CreateConnectionParams {
  /** One of `ConnectionList.connectors`, such as `slack`. */
  connector: string;
  display_name: string;
  /**
   * Checked with the provider first: refused is a 422 on `credentials`,
   * unreachable a 502. Left out, the connection is `pending` until an update
   * carries them. Sent, never returned.
   */
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** 1 to 10,000. */
  rate_limit_per_minute?: number;
}

/** Every field optional; one left out is unchanged. */
export interface UpdateConnectionParams {
  display_name?: string;
  /** An admin switches a connection on or off; `revoked` and `error` are the provider's. */
  status?: "active" | "disabled";
  rate_limit_per_minute?: number;
  config?: Record<string, unknown>;
  /** Checked with the provider as on create; they activate a pending connection. Sent, never returned. */
  credentials?: Record<string, unknown>;
}

/**
 * `GET /api/org/connections/slack/manifest`: the Slack app manifest for one
 * Slack connection, the request URL it names, Slack's create-from-manifest
 * link carrying it, and whether that URL is one Slack can reach (https, and
 * not a local name).
 */
export interface SlackManifest {
  connection_id: string;
  status: ConnectionStatus;
  request_url: string;
  publicly_reachable: boolean;
  manifest: Record<string, unknown>;
  create_url: string;
}

/**
 * One channel a connection answers, with the preset it answers with and the
 * member who pays. `preset_name` is null once the preset is deleted; the
 * route then refuses with `preset_missing` until it names another.
 */
export interface ConnectionRoute {
  id: string;
  connection_id: string;
  external_channel_id: string;
  channel_label: string;
  preset_id: string;
  preset_name: string | null;
  paying_subject: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The channels one connection answers. A channel not listed is never answered. */
export interface ConnectionRouteList {
  data: ConnectionRoute[];
}

export interface CreateConnectionRouteParams {
  external_channel_id: string;
  /** One of the org's presets; another org's is a 422. */
  preset_id: string;
  /** A current member, who pays for the channel's turns. */
  paying_subject: string;
  channel_label?: string;
  enabled?: boolean;
}

/** Every field optional; one left out is unchanged. */
export interface UpdateConnectionRouteParams {
  channel_label?: string;
  preset_id?: string;
  paying_subject?: string;
  enabled?: boolean;
}

export type IdentityStatus = "mapped" | "unmapped" | "guest" | "blocked" | (string & {});

/**
 * Someone a connection has heard from, and which member they are.
 * `mapped_by` says whether the email matched (`auto`) or an admin decided
 * (`manual`). `connector` and `connection_name` are on the rows of
 * `identities.forMember`, which span connections.
 */
export interface ConnectionIdentity {
  id: string;
  connection_id: string;
  external_user_id: string;
  display_name: string | null;
  email: string | null;
  subject: string | null;
  status: IdentityStatus;
  mapped_by: string;
  created_at: string;
  updated_at: string;
  connector?: string;
  connection_name?: string;
}

export interface ConnectionIdentityList {
  data: ConnectionIdentity[];
}

export interface ListConnectionIdentitiesParams {
  status?: IdentityStatus;
}

/**
 * One event a connection received and what became of it (`outcome`): ids,
 * never what anyone wrote. `accepted` is in flight, `answered` handled to
 * the end; every other outcome names a refusal or a failure.
 */
export interface ConnectionEvent {
  id: string;
  connection_id: string;
  external_event_id: string | null;
  received_at: string;
  kind: string;
  outcome: string;
  external_user_id: string | null;
  external_channel_id: string | null;
  conversation_id: string | null;
  paying_subject: string | null;
  detail: string | null;
  updated_at: string;
}

/** One page of a connection's event log, newest first. `next_cursor` fetches the page after this one; null on the last. */
export interface ConnectionEventPage {
  data: ConnectionEvent[];
  next_cursor: string | null;
}

export interface ListConnectionEventsParams {
  /** One of `ConnectionList.outcomes`. */
  outcome?: string;
  /** An instant with its zone (`Z` or an offset); one without is refused. */
  since?: string;
  /** A previous page's `next_cursor`. */
  cursor?: string;
  /** 1 to 200, 50 when omitted. */
  limit?: number;
}
