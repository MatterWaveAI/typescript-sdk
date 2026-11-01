/**
 * The organisation clients: `org` (the org, its model allow-list, sharing,
 * SSO and two-factor settings, and `org.domains` and `org.idps`),
 * `members` (with the invites and links beside the members), `invites` and
 * `inviteLinks`, one method per route on top of the client's request and
 * retry loop.
 *
 *     const admin = new MatterWave({ accessToken: session.accessToken });
 *     await admin.members.setRole(subject, "admin");
 *
 * These routes gate on the caller's membership row, not a key scope: they
 * need a person's token (`accessToken`, `client.auth.person`) and refuse
 * every API key 403 "Membership is managed by a person, not an API key."
 * Reading is open to any member where the web app shows it to any member
 * (the org, its members and invites); the rest is an owner's or admin's,
 * and some (closing the org, transferring ownership, requiring SSO or
 * two-factor) an owner's alone. The lookups (`invites.lookup`,
 * `inviteLinks.lookup`, `members.lookupInvite`, `members.lookupJoinLink`)
 * are the exceptions: anonymous, the token being the credential.
 */

import { MatterWaveConfigError } from "./client.js";
import type { MatterWave, RequestOptions } from "./client.js";
import { segment } from "./conversations.js";
import { Resource, present } from "./native.js";
import type {
  ClaimDomainParams,
  CreatedInvite,
  CreatedInviteLink,
  DomainChallengeAnswer,
  InvitePreview,
  JoinPreview,
  OrgDomainRow,
  OrgIdpRow,
  OrgMember,
  RenameOrgParams,
  SetModelPolicyParams,
  SetRoleParams,
  SetSsoParams,
  SsoEnforced,
  SsoRelaxed,
} from "./native-types.js";
import type {
  AttachIdpParams,
  CloseOrgParams,
  ClosedOrg,
  CreateInviteLinkParams,
  CreateInviteParams,
  Domain,
  DomainChallenge,
  DomainList,
  DomainVerification,
  IdentityProvider,
  IdentityProviderList,
  Invite,
  InviteLink,
  InviteLinkList,
  InviteList,
  InviteLookup,
  LinkLookup,
  Member,
  MemberList,
  MfaSettings,
  MintedRecoveryCode,
  ModelPolicy,
  Org,
  OrgRole,
  OrgShareList,
  RevokedOrgShare,
  SharingPolicy,
  SsoSettings,
} from "./org-types.js";
import type { WithRequestId } from "./types.js";

const ROLES: readonly OrgRole[] = ["owner", "admin", "member", "viewer"];
const LINK_MAX_USES = 500;
const LINK_MAX_DAYS = 30;
const MODELS_MAX = 200;

function checkRole(role: string): void {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new MatterWaveConfigError(`role must be one of ${ROLES.join(", ")}, got ${role}`);
  }
}

function checkBounded(name: string, value: number, low: number, high: number): void {
  if (!(value >= low && value <= high)) throw new MatterWaveConfigError(`${name} must be ${low} to ${high}, got ${value}`);
}

/** The body of a lookup, an acceptance or a join: the invite's or the link's token. */
function tokenBody(token: string): { token: string } {
  if (!token || token.length > 256) {
    throw new MatterWaveConfigError("token must be the invite's token, 1 to 256 characters");
  }
  return { token };
}

/** The OIDC provider's body, checked: an https issuer, and a secret that is sent once. */
function idpBody(params: AttachIdpParams): Record<string, unknown> {
  const kind = params.kind ?? "oidc";
  if (kind !== "oidc") throw new MatterWaveConfigError(`kind must be "oidc", got ${kind}`);
  if (!params.issuer?.startsWith("https://")) throw new MatterWaveConfigError("issuer must be an https:// URL");
  const body: Record<string, unknown> = {
    kind,
    name: params.name,
    issuer: params.issuer,
    client_id: params.client_id,
    client_secret: params.client_secret,
  };
  if (params.scopes !== undefined) body.scopes = params.scopes;
  return body;
}

// --- domains and identity providers --------------------------------------------

function domainPath(domain: string, suffix = ""): string {
  return `/api/org/domains/${segment("domain", domain)}${suffix}`;
}

/**
 * `/api/org/domains`: the email domains the org claims, each proven by a
 * DNS TXT record. Owner or admin. The claim decides whose address gets an
 * SSO button, so the proof is a security boundary, not a form field.
 */
export class Domains extends Resource {
  list(options: RequestOptions = {}): Promise<WithRequestId<DomainList>> {
    return this.call("GET", "/api/org/domains", undefined, options);
  }

  /** Claim `domain` (unverified until its record is found). `ConflictError` when another org holds it, with no hint of whose. */
  claim(domain: string, options: RequestOptions = {}): Promise<WithRequestId<Domain>> {
    if (!domain || domain.length > 253) {
      throw new MatterWaveConfigError("a domain is 1 to 253 characters, like example.com");
    }
    return this.call("POST", "/api/org/domains", { domain }, options);
  }

  /** The TXT record to publish, minted on first ask and the same on every call. */
  challenge(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainChallenge>> {
    return this.call("GET", domainPath(domain, "/challenge"), undefined, options);
  }

  /**
   * Look the record up now. Not finding it yet is the route's 202, which
   * resolves like its 200 with `verified` false rather than an error; run
   * it again once DNS has caught up. A 503 means the check could not be run.
   */
  verify(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainVerification>> {
    return this.call("POST", domainPath(domain, "/verify"), undefined, options);
  }

  release(domain: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", domainPath(domain), options);
  }
}

/** `/api/org/idp`: the OIDC providers the org's members sign in through. Owner or admin. */
export class IdentityProviders extends Resource {
  /** The attached providers, never their secrets. */
  list(options: RequestOptions = {}): Promise<WithRequestId<IdentityProviderList>> {
    return this.call("GET", "/api/org/idp", undefined, options);
  }

  /**
   * Attach an OIDC provider by its https `issuer`. The secret goes once and
   * is never read back; a provider that refuses the configuration is the
   * server's 422, naming the issuer.
   */
  attach(params: AttachIdpParams, options: RequestOptions = {}): Promise<WithRequestId<IdentityProvider>> {
    return this.call("POST", "/api/org/idp", idpBody(params), options);
  }

  /** Detach a provider: the row goes first, so nobody is sent to a provider that is about to disappear. */
  detach(provider: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/idp/${segment("provider", provider)}`, options);
  }
}

// --- the org -------------------------------------------------------------------

/**
 * `/api/org`: the organisation and its settings. Reading the org is any
 * member's; its model policy, sharing, SSO, domains and identity providers
 * an owner's or admin's; closing it, requiring SSO or two-factor and minting
 * a recovery code an owner's alone (relaxing SSO is open to any admin, so
 * the person undoing a lock-out does not need the person who caused it).
 * The audit trail beside these lives on `client.audit`.
 */
export class OrgClient extends Resource {
  /** The email domains the org claims, each proven by a DNS record. */
  readonly domains: Domains;
  /** The OIDC providers the org's members sign in through. */
  readonly idps: IdentityProviders;

  constructor(client: MatterWave) {
    super(client);
    this.domains = new Domains(client);
    this.idps = new IdentityProviders(client);
  }

  /** The org, with the caller's own role in it. Any member. */
  get(options: RequestOptions = {}): Promise<WithRequestId<Org>> {
    return this.call("GET", "/api/org", undefined, options);
  }

  /** Rename the org (1 to 120 characters), given as the name or as `{ name }`. Owner or admin; audited. */
  rename(name: string | RenameOrgParams, options: RequestOptions = {}): Promise<WithRequestId<Org>> {
    const named = typeof name === "string" ? name : name?.name;
    if (!named?.trim() || named.length > 120) throw new MatterWaveConfigError("an org name is 1 to 120 characters");
    return this.call("PATCH", "/api/org", { name: named }, options);
  }

  /**
   * Close the org for good: `confirm` is its name, typed out exactly
   * (case-insensitive). Every conversation is deleted (erased after the
   * retention period), the keys, invites and links are revoked, the
   * subscription is cancelled, the members are mailed, and every later
   * request from the org is a 410. Owner only; a retry repeats nothing but
   * the side effects that failed.
   */
  close(params: CloseOrgParams, options: RequestOptions = {}): Promise<WithRequestId<ClosedOrg>> {
    if (!params.confirm?.trim()) {
      throw new MatterWaveConfigError("Type the organisation's name exactly to confirm.");
    }
    return this.call("POST", "/api/org/close", { confirm: params.confirm }, options);
  }

  /** The model allow-list: every model the plan offers and whether the org allows it. Owner or admin. */
  models(options: RequestOptions = {}): Promise<WithRequestId<ModelPolicy>> {
    return this.call("GET", "/api/org/models", undefined, options);
  }

  /**
   * Allow exactly these model ids (the house model always stays), or with
   * `null` every model the plan offers; given as the list or as
   * `{ allowed }`. A model the plan does not offer is the server's 422.
   */
  setModels(allowed: string[] | null | SetModelPolicyParams, options: RequestOptions = {}): Promise<WithRequestId<ModelPolicy>> {
    const list = allowed === null || Array.isArray(allowed) ? allowed : allowed?.allowed;
    if (list !== null && !Array.isArray(list)) {
      throw new MatterWaveConfigError("allowed must be a list of model ids or null");
    }
    if (list !== null && list.length > MODELS_MAX) throw new MatterWaveConfigError(`allow at most ${MODELS_MAX} models`);
    return this.call("PUT", "/api/org/models", { allowed: list }, options);
  }

  /** Whether members may share conversations by link. Owner or admin. */
  sharing(options: RequestOptions = {}): Promise<WithRequestId<SharingPolicy>> {
    return this.call("GET", "/api/org/sharing", undefined, options);
  }

  /**
   * Allow or stop share links, given as the switch or as `{ enabled }`.
   * Stopping silences every link at once without revoking it, so turning it
   * back on restores them. Owner or admin, and audited.
   */
  setSharing(enabled: boolean | SharingPolicy, options: RequestOptions = {}): Promise<WithRequestId<SharingPolicy>> {
    const on = typeof enabled === "boolean" ? enabled : enabled?.enabled;
    if (typeof on !== "boolean") throw new MatterWaveConfigError("enabled must be a boolean");
    return this.call("PUT", "/api/org/sharing", { enabled: on }, options);
  }

  /** Every share link the org's members made, newest first, with who made each; never a token. */
  shares(options: RequestOptions = {}): Promise<WithRequestId<OrgShareList>> {
    return this.call("GET", "/api/org/shares", undefined, options);
  }

  /** Revoke any link in the org. Another org's link and one that does not exist are the same 404. */
  revokeShare(shareId: string, options: RequestOptions = {}): Promise<WithRequestId<RevokedOrgShare>> {
    return this.call("DELETE", `/api/org/shares/${segment("shareId", shareId)}`, undefined, options);
  }

  /** Whether SSO is required, and what blocks requiring it. */
  sso(options: RequestOptions = {}): Promise<WithRequestId<SsoSettings>> {
    return this.call("GET", "/api/org/sso", undefined, options);
  }

  /**
   * Require SSO (owner only) or stop requiring it (owner or admin), given
   * as the switch or as `{ sso_required }`. Requiring it answers with a
   * break-glass `recovery` code, shown this once -- there is no way to reach
   * the enforced state without being handed the way back out of it;
   * `ConflictError` while a blocker would lock the org out.
   */
  setSso(required: boolean, options?: RequestOptions): Promise<WithRequestId<SsoSettings>>;
  setSso(params: SetSsoParams, options?: RequestOptions): Promise<WithRequestId<SsoEnforced | SsoRelaxed>>;
  setSso(required: boolean | SetSsoParams, options: RequestOptions = {}): Promise<WithRequestId<SsoSettings | SsoEnforced | SsoRelaxed>> {
    const on = typeof required === "boolean" ? required : required?.sso_required;
    if (typeof on !== "boolean") throw new MatterWaveConfigError("sso_required must be a boolean");
    return this.call("PUT", "/api/org/sso", { sso_required: on }, options);
  }

  /** A new break-glass code, superseding any unused one. Owner only, and audited. */
  mintRecoveryCode(options: RequestOptions = {}): Promise<WithRequestId<MintedRecoveryCode>> {
    return this.call("POST", "/api/org/sso/recovery-code", undefined, options);
  }

  mfa(options: RequestOptions = {}): Promise<WithRequestId<MfaSettings>> {
    return this.call("GET", "/api/org/mfa", undefined, options);
  }

  /** Require a second factor of every member, or stop. Owner only. */
  setMfa(required: boolean, options: RequestOptions = {}): Promise<WithRequestId<MfaSettings>> {
    return this.call("PUT", "/api/org/mfa", { mfa_required: required }, options);
  }

  /** `POST /api/org/domains` (201): claim a domain, unverified, as `domains.claim` does. Owner or admin. */
  claimDomain(params: ClaimDomainParams, options: RequestOptions = {}): Promise<WithRequestId<OrgDomainRow>> {
    if (!params.domain?.trim()) throw new MatterWaveConfigError("domain must be a domain like example.com");
    return this.call("POST", "/api/org/domains", params, options);
  }

  /** `GET /api/org/domains/{domain}/challenge`: the DNS TXT record to publish, as `domains.challenge` reads it. */
  domainChallenge(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainChallengeAnswer>> {
    return this.call("GET", domainPath(domain, "/challenge"), undefined, options);
  }

  /**
   * `POST /api/org/domains/{domain}/verify`: prove the claim, as
   * `domains.verify` does. 200 proven; 202 the record is not there yet (the
   * claim stands, `detail` says what was wrong); 503 the check could not be
   * run at all.
   */
  verifyDomain(domain: string, options: RequestOptions = {}): Promise<WithRequestId<DomainVerification>> {
    return this.call("POST", domainPath(domain, "/verify"), undefined, options);
  }

  /** `DELETE /api/org/domains/{domain}`: release the claim, as `domains.release` does. Owner or admin. */
  releaseDomain(domain: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", domainPath(domain), options);
  }

  /** `POST /api/org/idp` (201): attach an OIDC provider, as `idps.attach` does; `client_secret` must be given. Owner or admin. */
  attachIdp(params: AttachIdpParams, options: RequestOptions = {}): Promise<WithRequestId<OrgIdpRow>> {
    const body = idpBody(params);
    if (!params.name?.trim()) throw new MatterWaveConfigError("name must not be blank");
    if (!params.client_id?.trim()) throw new MatterWaveConfigError("client_id must not be blank");
    if (!params.client_secret) throw new MatterWaveConfigError("client_secret must be non-empty");
    return this.call("POST", "/api/org/idp", body, options);
  }

  /** `DELETE /api/org/idp/{provider}`: detach a provider, as `idps.detach` does. Owner or admin. */
  detachIdp(provider: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/idp/${segment("provider", provider)}`, options);
  }
}

// --- members, invites and links --------------------------------------------------

function memberPath(subject: string, suffix = ""): string {
  return `/api/org/members/${segment("subject", subject)}${suffix}`;
}

function invitePath(inviteId: string, suffix = ""): string {
  return `/api/org/invites/${segment("inviteId", inviteId)}${suffix}`;
}

/** A link's role, uses and life, checked: never an owner link, 1 to 500 uses, 1 to 30 days. */
function linkBody(params: CreateInviteLinkParams, ownerRefusal: string): Record<string, unknown> {
  const role = params.role ?? "member";
  checkRole(role);
  if (role === "owner") throw new MatterWaveConfigError(ownerRefusal);
  const maxUses = params.max_uses ?? 10;
  const expiresInDays = params.expires_in_days ?? 7;
  checkBounded("max_uses", maxUses, 1, LINK_MAX_USES);
  checkBounded("expires_in_days", expiresInDays, 1, LINK_MAX_DAYS);
  return { role, max_uses: maxUses, expires_in_days: expiresInDays };
}

/**
 * `/api/org/members`: who is in the org and in what role. Any member lists
 * members and invites and may leave (remove themselves); owner and admin
 * change roles, remove others, invite, resend, revoke and manage links; only
 * an owner touches an owner or grants ownership. An invite that would pass
 * the plan's seat cap is refused with the 402 every entitlement gate
 * answers. The invites and links are here too (`listInvites`,
 * `createInviteLink`, `join`, ...), as `invites` and `inviteLinks` have them.
 */
export class Members extends Resource {
  /** Every member, the caller's own role, and the seats. Any member. */
  list(options: RequestOptions = {}): Promise<WithRequestId<MemberList>> {
    return this.call("GET", "/api/org/members", undefined, options);
  }

  /**
   * `owner`, `admin`, `member` or `viewer`, given as the role or as
   * `{ role }`. Owner or admin, and only an owner grants or takes
   * ownership; `ConflictError` when it would leave the org without an owner.
   */
  setRole(subject: string, role: OrgRole | SetRoleParams, options: RequestOptions = {}): Promise<WithRequestId<Member>> {
    const named = typeof role === "string" ? role : role?.role;
    checkRole(named);
    return this.call("PUT", memberPath(subject, "/role"), { role: named }, options);
  }

  /** Make an active member the owner; the caller becomes an admin, together or not at all. Owner only. */
  transferOwnership(subject: string, options: RequestOptions = {}): Promise<WithRequestId<Member>> {
    return this.call("POST", memberPath(subject, "/transfer-ownership"), undefined, options);
  }

  /** Remove a member (owner or admin), or leave (anyone, as themselves, unless the last owner). The seats are billed again. */
  remove(subject: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", memberPath(subject), options);
  }

  /** `GET /api/org/invites`: the mailed invites and where each stands, as `invites.list` reads them. Any member. */
  listInvites(options: RequestOptions = {}): Promise<WithRequestId<InviteList>> {
    return this.call("GET", "/api/org/invites", undefined, options);
  }

  /** `POST /api/org/invites` (201): invite `email` at a role and mail it, as `invites.create` does. A relay failure does not undo the row -- `mail: "failed"` says so, and a resend is the recovery. Owner or admin. */
  createInvite(params: CreateInviteParams & { email: string }, options: RequestOptions = {}): Promise<WithRequestId<CreatedInvite>> {
    if (!params.email?.includes("@")) throw new MatterWaveConfigError("email must be an email address");
    if (params.role !== undefined) checkRole(params.role);
    return this.call("POST", "/api/org/invites", { role: "member", ...present(params) }, options);
  }

  /** `POST /api/org/invites/{id}/resend`: a new token, a new expiry and the mail again. Three an hour per invite, so a refused resend leaves the last link working. Owner or admin. */
  resendInvite(inviteId: string, options: RequestOptions = {}): Promise<WithRequestId<CreatedInvite>> {
    return this.call("POST", invitePath(inviteId, "/resend"), undefined, options);
  }

  /** `DELETE /api/org/invites/{id}`: revoke an invite for good. Owner or admin. */
  revokeInvite(inviteId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", invitePath(inviteId), options);
  }

  /** `POST /api/org/invites/lookup`: what a /join page asks before it renders, as `invites.lookup` does. Anonymous: the token is the credential, sent in the body so it stays out of access logs. */
  lookupInvite(token: string, options: RequestOptions = {}): Promise<WithRequestId<InvitePreview>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.callAnon("POST", "/api/org/invites/lookup", { token }, options);
  }

  /** `POST /api/org/invites/accept`: redeem a mailed invite as the account whose address was invited. An account in another org cannot be moved (409 says so). */
  acceptInvite(token: string, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.call("POST", "/api/org/invites/accept", { token }, options);
  }

  /** `GET /api/org/invite-links`: the links not revoked, with their uses. Owner or admin -- a link admits whoever holds it. */
  listInviteLinks(options: RequestOptions = {}): Promise<WithRequestId<InviteLinkList>> {
    return this.call("GET", "/api/org/invite-links", undefined, options);
  }

  /**
   * `POST /api/org/invite-links` (201): make a link and get its `token`
   * and `url` -- once; only the hash is kept, so a lost link is revoked and
   * replaced, never shown again. Never an owner link. Owner or admin.
   */
  createInviteLink(params: CreateInviteLinkParams = {}, options: RequestOptions = {}): Promise<WithRequestId<CreatedInviteLink>> {
    return this.call("POST", "/api/org/invite-links", linkBody(params, "An invite link is never an owner link."), options);
  }

  /** `DELETE /api/org/invite-links/{id}`: revoke a link; the joins it already made stand. Owner or admin. */
  revokeInviteLink(linkId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/invite-links/${segment("linkId", linkId)}`, options);
  }

  /** `POST /api/join/lookup`: whose org a link leads to, which role, whether it still works. Anonymous -- the token is the credential. */
  lookupJoinLink(token: string, options: RequestOptions = {}): Promise<WithRequestId<JoinPreview>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.callAnon("POST", "/api/join/lookup", { token }, options);
  }

  /** `POST /api/join`: join through a link. A revoked link is the same 404 as none; an expired or used-up one is a 410. */
  join(token: string, options: RequestOptions = {}): Promise<WithRequestId<OrgMember>> {
    if (!token) throw new MatterWaveConfigError("token must be non-empty");
    return this.call("POST", "/api/join", { token }, options);
  }
}

/** `/api/org/invites`: invitations by email. The join link travels only in the mail; nothing here returns it. */
export class Invites extends Resource {
  /** The open invites, newest first. Any member. */
  list(options: RequestOptions = {}): Promise<WithRequestId<InviteList>> {
    return this.call("GET", "/api/org/invites", undefined, options);
  }

  /**
   * Invite `email` and mail them the link. `mail` on the answer says
   * whether the mail went. Owner or admin (an owner, to invite an owner);
   * `ConflictError` for a member or a pending invite, and a 402 when the
   * plan's seats are full.
   */
  create(email: string, params: CreateInviteParams = {}, options: RequestOptions = {}): Promise<WithRequestId<Invite>> {
    if (!email.includes("@") || email.length < 3 || email.length > 254) {
      throw new MatterWaveConfigError(`not an email address: ${email}`);
    }
    const role = params.role ?? "member";
    checkRole(role);
    return this.call("POST", "/api/org/invites", { email, role }, options);
  }

  /** Mail it again with a new link; the old link stops working. Three an hour per invite. */
  resend(inviteId: string, options: RequestOptions = {}): Promise<WithRequestId<Invite>> {
    return this.call("POST", invitePath(inviteId, "/resend"), undefined, options);
  }

  revoke(inviteId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", invitePath(inviteId), options);
  }

  /** What the invite in a mail leads to. Anonymous: no credential is sent. */
  lookup(token: string, options: RequestOptions = {}): Promise<WithRequestId<InviteLookup>> {
    return this.client.json<InviteLookup>(
      { method: "POST", path: "/api/org/invites/lookup", body: tokenBody(token), keyed: false, stream: false },
      options,
    );
  }

  /** Join the org the invite is for, as the person it was sent to. A 410 once it has expired. */
  accept(token: string, options: RequestOptions = {}): Promise<WithRequestId<Member>> {
    return this.call("POST", "/api/org/invites/accept", tokenBody(token), options);
  }
}

/**
 * `/api/org/invite-links` and `/api/join`: shareable links anyone with the
 * link may join through, up to `max_uses` times before it expires.
 */
export class InviteLinks extends Resource {
  /** The links not revoked. Owner or admin. */
  list(options: RequestOptions = {}): Promise<WithRequestId<InviteLinkList>> {
    return this.call("GET", "/api/org/invite-links", undefined, options);
  }

  /**
   * A new link for `role` (never `owner`), 1 to 500 uses, 1 to 30 days.
   * Its `token` and `url` are on this answer only. Owner or admin.
   */
  create(params: CreateInviteLinkParams = {}, options: RequestOptions = {}): Promise<WithRequestId<InviteLink>> {
    return this.call(
      "POST",
      "/api/org/invite-links",
      linkBody(params, "ownership is never granted by link; invite an owner by email"),
      options,
    );
  }

  revoke(linkId: string, options: RequestOptions = {}): Promise<void> {
    return this.none("DELETE", `/api/org/invite-links/${segment("linkId", linkId)}`, options);
  }

  /** What a link leads to. Anonymous: no credential is sent. */
  lookup(token: string, options: RequestOptions = {}): Promise<WithRequestId<LinkLookup>> {
    return this.client.json<LinkLookup>(
      { method: "POST", path: "/api/join/lookup", body: tokenBody(token), keyed: false, stream: false },
      options,
    );
  }

  /** Join the org through a link. A 410 when it has expired or is used up. */
  join(token: string, options: RequestOptions = {}): Promise<WithRequestId<Member>> {
    return this.call("POST", "/api/join", tokenBody(token), options);
  }
}
