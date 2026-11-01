/**
 * The organisation routes' wire types: the org itself, its members,
 * invites and invite links, its model allow-list, sharing, SSO, two-factor
 * and domain and identity-provider settings, its billing administration,
 * and the device-login decisions a person makes. Spelled as the routes in
 * api/matterwave send them; a field added later is ignored, not refused.
 *
 * Some of them carry a secret once -- an invite link's `token` and `url`,
 * an SSO recovery `code` -- which the field's doc comment says.
 */

import type { ApiKey } from "./native-types.js";

/** A member's role, most powerful first. */
export type OrgRole = "owner" | "admin" | "member" | "viewer";

// --- the org -------------------------------------------------------------------

/**
 * `GET`/`PATCH /api/org`: the organisation, and `role`, the caller's own
 * role in it (`owner`, `admin`, `member` or `viewer`).
 */
export interface Org {
  id: string;
  name: string;
  created_at: string;
  role: string;
}

/** The body of `org.close`. */
export interface CloseOrgParams {
  /** The org's name, typed out. */
  confirm: string;
}

/**
 * `POST /api/org/close`: what closing did. Conversations are erased after
 * `retention_days`; `subscription` is `cancelled`, `none` or `failed`.
 * `already_closed` on a retry, which repeats nothing.
 */
export interface ClosedOrg {
  status: string;
  closed_at: string;
  already_closed: boolean;
  conversations_deleted: number;
  retention_days: number;
  api_keys_revoked: number | null;
  invites_revoked: number | null;
  invite_links_revoked: number | null;
  subscription: string;
  members_mailed: number;
  members_not_mailed: number;
  identity_removed: boolean;
}

// --- members, invites and links --------------------------------------------------

/** One member. `state` is `pending_verification`, `active` or `suspended`. */
export interface Member {
  subject: string;
  email: string;
  name: string | null;
  role: string;
  state: string;
  created_at: string;
  last_seen_at: string | null;
}

/**
 * Seats in use (members and pending invites), the plan's maximum (null for
 * unlimited) and how many are billed.
 */
export interface Seats {
  used: number;
  max: number | null;
  billed: number | null;
}

/** `GET /api/org/members`: every member, the caller's own `role`, and the seats. */
export interface MemberList {
  data: Member[];
  role: string;
  seats: Seats;
}

/**
 * An invite by email. `status` is `pending`, `accepted`, `expired` or
 * `revoked`. The join link itself is only ever in the mail.
 */
export interface Invite {
  id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: string;
  expires_at: string;
  status: string;
  /** On `create` and `resend`: whether the mail went, `sent` or `failed`. */
  mail?: string | null;
  /** Beside a `failed` mail: what to do, which is to resend. */
  detail?: string | null;
}

/** `GET /api/org/invites`: the open invites, newest first. */
export interface InviteList {
  data: Invite[];
}

/** The options of `invites.create`. */
export interface CreateInviteParams {
  /** `member` when omitted; only an owner invites an owner. */
  role?: OrgRole;
}

/** What an invite's token leads to, before it is accepted. */
export interface InviteLookup {
  org_name: string;
  email: string;
  role: string;
  expires_at: string;
  status: string;
}

/** A shareable join link. `status` is `active`, `expired`, `used_up` or `revoked`. */
export interface InviteLink {
  id: string;
  role: string;
  max_uses: number;
  uses: number;
  created_by: string;
  created_at: string;
  expires_at: string;
  status: string;
  /**
   * On the answer to `create` only, and absent everywhere else: the link's
   * secret, shown this once. Anyone holding it can join, so keep it out of
   * logs.
   */
  token?: string | null;
  /** The join URL carrying `token`: shown once, and as secret as the token. */
  url?: string | null;
}

/** `GET /api/org/invite-links`: the links not revoked. */
export interface InviteLinkList {
  data: InviteLink[];
}

/** The options of `inviteLinks.create`. */
export interface CreateInviteLinkParams {
  /** `member` when omitted; never `owner`, which only an invite by email grants. */
  role?: OrgRole;
  /** 1 to 500; 10 when omitted. */
  max_uses?: number;
  /** 1 to 30; 7 when omitted. */
  expires_in_days?: number;
}

/** What a join link leads to: `status` is `active`, `expired` or `used_up`. */
export interface LinkLookup {
  org_name: string;
  role: string;
  expires_at: string;
  status: string;
}

// --- policies ------------------------------------------------------------------

/**
 * One model the plan offers: whether the org allows it, and `locked` for
 * the house model, which is always allowed.
 */
export interface ModelPolicyEntry {
  id: string;
  label: string;
  partner: boolean;
  context_window: number | null;
  research_preview: boolean;
  allowed: boolean;
  locked: boolean;
}

/**
 * `GET`/`PUT /api/org/models`: the org's model allow-list. `restricted` is
 * false when every model the plan allows is allowed; `unlisted` names
 * allowed ids the gateway no longer serves.
 */
export interface ModelPolicy {
  house_model: string;
  data: ModelPolicyEntry[];
  unlisted: string[];
  restricted: boolean;
}

/**
 * `GET`/`PUT /api/org/sharing`: whether members may share links. Turning it
 * off silences every link at once without revoking them.
 */
export interface SharingPolicy {
  enabled: boolean;
}

/** One share link a member made: never its token. `status` is `active`, `expired` or `revoked`. */
export interface OrgShare {
  id: string;
  conversation_id: string;
  title: string;
  message_count: number;
  include_attachments: boolean;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  status: string;
  created_by: string;
}

/** `GET /api/org/shares`: every link the org's members made. */
export interface OrgShareList {
  data: OrgShare[];
}

/** `DELETE /api/org/shares/{id}`: the link's new status. */
export interface RevokedOrgShare {
  status: string;
}

/** The break-glass code that signs an owner in past enforced SSO: valid 72 hours, once. */
export interface RecoveryCode {
  id: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  used_at: string | null;
  /** The secret, shown this once: store it offline, and keep it out of logs. */
  code: string;
  shown_once: boolean;
}

/**
 * `GET`/`PUT /api/org/sso`. `blockers` says why SSO cannot be required yet;
 * `recovery` is the code minted when it was just turned on.
 */
export interface SsoSettings {
  sso_required: boolean;
  blockers: string[];
  recovery?: RecoveryCode | null;
}

/** `POST /api/org/sso/recovery-code`: a new code, which supersedes any unused one. */
export interface MintedRecoveryCode {
  recovery: RecoveryCode;
}

/** `GET`/`PUT /api/org/mfa`: whether every member needs a second factor. */
export interface MfaSettings {
  mfa_required: boolean;
}

// --- domains and identity providers --------------------------------------------

/** A domain the org claims; verified once its DNS challenge is found. */
export interface Domain {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
}

export interface DomainList {
  data: Domain[];
}

/** The TXT record that proves a domain: publish `value` at `name`. */
export interface DnsRecord {
  type: string;
  host: string;
  name: string;
  value: string;
}

/** `GET /api/org/domains/{domain}/challenge`: the record, stable across calls. */
export interface DomainChallenge {
  record: DnsRecord;
}

/**
 * `POST /api/org/domains/{domain}/verify`, answered 200 when proven and 202
 * when not yet. Not yet `verified` is not an error: the record was not
 * found (`found` lists the TXT values that were, `detail` says what to do)
 * and the check can be run again.
 */
export interface DomainVerification {
  domain: string;
  verified: boolean;
  verified_at: string | null;
  verified_by: string | null;
  method: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  record?: DnsRecord | null;
  detail?: string | null;
  found?: string[];
}

/** An identity provider the org signs in through. The client secret is never returned. */
export interface IdentityProvider {
  provider: string;
  kind: string;
  name: string;
  issuer: string | null;
  created_at: string;
}

export interface IdentityProviderList {
  data: IdentityProvider[];
}

/** The body of `org.idps.attach`: an OIDC provider. */
export interface AttachIdpParams {
  /** `oidc`, the only kind there is; sent as that when omitted. */
  kind?: "oidc";
  name: string;
  /** The provider's https:// issuer URL. */
  issuer: string;
  client_id: string;
  /** Sent once and never read back. */
  client_secret: string;
  /** The provider's defaults when omitted. */
  scopes?: string[];
}

// --- billing administration ----------------------------------------------------

/** A Stripe page to send the person to: Checkout or the customer portal. */
export interface BillingLink {
  url: string;
}

/** The options of `billing.checkout`. */
export interface CheckoutParams {
  /** The plan's code, when it is not given on its own as the first argument. */
  plan?: string;
  /** Pay yearly rather than monthly; false when omitted. */
  annual?: boolean;
}

/** The options of `billing.changePlan`. */
export interface ChangePlanParams {
  /** Why, kept in the plan history. */
  reason?: string;
}

/**
 * One invoice. Amounts are micro-dollars; `hosted_invoice_url` is where it
 * is paid and `invoice_pdf` its PDF.
 */
export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  collection_method: string;
  currency: string;
  amount_due_micros: number;
  amount_remaining_micros: number;
  due_at: string | null;
  paid_at: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  issued_at: string;
  dispute_status: string | null;
}

/** `GET /api/billing/invoices`: the latest 24, newest first. */
export interface InvoiceList {
  data: Invoice[];
}

/** One change of plan or status, who made it and why. */
export interface PlanChange {
  from_plan: string | null;
  to_plan: string | null;
  from_status: string | null;
  to_status: string | null;
  kind: string;
  actor: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** `GET /api/plan/history`: the latest 50 changes, newest first. */
export interface PlanHistory {
  data: PlanChange[];
}

// --- device login decisions ----------------------------------------------------

/** Which client asked for a code, before the person decides. */
export interface DeviceLookup {
  user_code: string;
  client_name: string | null;
  expires_in: number;
}

/** The options of `auth.device.approve`. */
export interface ApproveDeviceParams {
  /** What to name the key the device gets; the client's name when omitted. */
  name?: string;
}

/**
 * `approved` or `denied`. On approval, `key` is the API key minted for the
 * device -- its row, never the secret, which goes only to the device's
 * next poll.
 */
export interface DeviceDecision {
  status: string;
  client_name: string | null;
  key?: ApiKey | null;
}
