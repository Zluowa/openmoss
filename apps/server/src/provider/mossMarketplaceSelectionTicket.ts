// FILE: mossMarketplaceSelectionTicket.ts
// Purpose: Server-owned, short-lived attestations for a user's explicit
//          catalog selection. The token is an opaque map key; this seam does
//          not download, install, or execute catalog content.

import { randomBytes } from "node:crypto";

import type {
  ProviderCatalogArtifactLocator,
  ProviderCatalogEntry,
  ProviderCatalogSelectionContext,
  ProviderCatalogSelectionTicket,
  ProviderCatalogSelectionTicketClaims,
} from "@synara/contracts";

import { isMossMarketplaceAllowedArtifactUrl } from "./mossMarketplaceAggregationSources.ts";

export type MossMarketplaceSelectionTicketErrorCode =
  | "SELECTION_TICKET_INVALID"
  | "SELECTION_TICKET_EXPIRED"
  | "SELECTION_TICKET_USED"
  | "SELECTION_TICKET_REVOKED"
  | "SELECTION_TICKET_STATE_CHANGED"
  | "SELECTION_TICKET_CONTEXT_MISMATCH"
  | "SELECTION_TICKET_AUTH_REQUIRED"
  | "SELECTION_TICKET_ARTIFACT_INVALID"
  | "SELECTION_TICKET_NOT_ELIGIBLE";

export class MossMarketplaceSelectionTicketError extends Error {
  readonly code: MossMarketplaceSelectionTicketErrorCode;

  constructor(code: MossMarketplaceSelectionTicketErrorCode) {
    super(code);
    this.name = "MossMarketplaceSelectionTicketError";
    this.code = code;
  }
}

export interface MossMarketplaceSelectionTicketIssueInput {
  readonly entry: ProviderCatalogEntry;
  readonly authenticatedActorId: string;
  readonly selectionContext: ProviderCatalogSelectionContext;
  readonly artifact?: ProviderCatalogArtifactLocator | null | undefined;
}

export interface MossMarketplaceSelectionTicketVerifyInput {
  readonly token: string;
  readonly currentEntry: ProviderCatalogEntry | null;
  readonly authenticatedActorId: string;
  readonly selectionContext: ProviderCatalogSelectionContext;
  readonly artifact?: ProviderCatalogArtifactLocator | null | undefined;
}

export interface MossMarketplaceSelectionTicketOptions {
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxTickets?: number;
  readonly artifactUrlAllowed?: ((url: string) => boolean) | undefined;
}

export interface MossMarketplaceSelectionTicketVerifyOptions {
  /** Planning verifies the current catalog state without consuming the ticket. */
  readonly consume?: boolean;
}

interface StoredTicket {
  readonly claims: ProviderCatalogSelectionTicketClaims;
  used: boolean;
  revoked: boolean;
}

function normalizedArtifact(
  artifact: ProviderCatalogArtifactLocator | null | undefined,
): ProviderCatalogArtifactLocator | null {
  return artifact ?? null;
}

function cloneFrozenSelectionContext(
  context: ProviderCatalogSelectionContext,
): ProviderCatalogSelectionContext {
  return Object.freeze({
    actionId: context.actionId,
    actorId: context.actorId,
    selectedAt: context.selectedAt,
  });
}

function validateArtifact(
  artifact: ProviderCatalogArtifactLocator | null | undefined,
  isAllowedUrl: (url: string) => boolean,
): void {
  if (artifact === undefined || artifact === null) return;
  if (artifact.url === null || artifact.sha256 === null) {
    throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_ARTIFACT_INVALID");
  }
  const isStrictHttpsUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        (!parsed.port || parsed.port === "443")
      );
    } catch {
      return false;
    }
  };
  if (
    artifact.url !== null &&
    (typeof artifact.url !== "string" ||
      artifact.url.trim().length === 0 ||
      !isStrictHttpsUrl(artifact.url) ||
      !isAllowedUrl(artifact.url))
  ) {
    throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_ARTIFACT_INVALID");
  }
  if (
    artifact.sha256 !== null &&
    (typeof artifact.sha256 !== "string" ||
      artifact.sha256.trim().length === 0 ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256))
  ) {
    throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_ARTIFACT_INVALID");
  }
}

function stateFingerprint(
  entry: ProviderCatalogEntry,
  artifact: ProviderCatalogArtifactLocator | null | undefined,
): string {
  return JSON.stringify({
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    displayName: entry.displayName,
    description: entry.description,
    tags: entry.tags,
    sourceIds: entry.sourceIds,
    sourceTiers: entry.sourceTiers,
    sourceUrl: entry.sourceUrl,
    homepageUrl: entry.homepageUrl,
    version: entry.version,
    compatibility: entry.compatibility,
    qualityScore: entry.qualityScore,
    installPolicy: entry.installPolicy,
    metadata: entry.metadata,
    verified: entry.verified,
    featured: entry.featured,
    license: entry.license,
    activity: entry.activity,
    security: entry.security,
    withdrawal: entry.withdrawal,
    provenance: entry.provenance,
    artifact: normalizedArtifact(artifact),
  });
}

function sameContext(
  left: ProviderCatalogSelectionContext,
  right: ProviderCatalogSelectionContext,
): boolean {
  return (
    left.actionId === right.actionId &&
    left.actorId === right.actorId &&
    left.selectedAt === right.selectedAt
  );
}

function hasAuthenticatedContext(
  authenticatedActorId: unknown,
  context: ProviderCatalogSelectionContext | undefined,
): context is ProviderCatalogSelectionContext {
  return (
    typeof authenticatedActorId === "string" &&
    authenticatedActorId.trim().length > 0 &&
    context !== undefined &&
    typeof context.actorId === "string" &&
    context.actorId.trim().length > 0 &&
    context.actorId === authenticatedActorId &&
    typeof context.actionId === "string" &&
    context.actionId.trim().length > 0
  );
}

function authoritativeSource(entry: ProviderCatalogEntry): {
  readonly id: string;
  readonly tier: ProviderCatalogSelectionTicketClaims["authoritativeSourceTier"];
  readonly sourceVersion: string | null;
  readonly generation: number;
  readonly snapshot: string;
} {
  const provenance = entry.provenance.identity;
  const id = provenance.sourceIds[0] ?? entry.sourceIds[0];
  const tier = provenance.sourceTiers[0] ?? entry.sourceTiers[0];
  if (!id || !tier) throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_INVALID");
  return {
    id,
    tier,
    sourceVersion: provenance.sourceVersion,
    generation: provenance.generation,
    snapshot: provenance.snapshot,
  };
}

export class MossMarketplaceSelectionTicketService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxTickets: number;
  private readonly artifactUrlAllowed: (url: string) => boolean;
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(options: MossMarketplaceSelectionTicketOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 60_000);
    this.maxTickets = Math.max(1, Math.floor(options.maxTickets ?? 1_024));
    this.artifactUrlAllowed = options.artifactUrlAllowed ?? isMossMarketplaceAllowedArtifactUrl;
  }

  issue(input: MossMarketplaceSelectionTicketIssueInput): ProviderCatalogSelectionTicket {
    const { entry } = input;
    if (!hasAuthenticatedContext(input.authenticatedActorId, input.selectionContext)) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_AUTH_REQUIRED");
    }
    if (entry.withdrawal || entry.security.status === "blocked") {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_NOT_ELIGIBLE");
    }
    validateArtifact(input.artifact, this.artifactUrlAllowed);
    const selectionContext = cloneFrozenSelectionContext(input.selectionContext);
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.valueOf() + this.ttlMs);
    const source = authoritativeSource(entry);
    const token = randomBytes(32).toString("base64url");
    const claims: ProviderCatalogSelectionTicketClaims = {
      identity: entry.id,
      kind: entry.kind,
      authoritativeSourceId: source.id,
      authoritativeSourceTier: source.tier,
      sourceVersion: source.sourceVersion,
      generation: source.generation,
      snapshot: source.snapshot,
      artifact: normalizedArtifact(input.artifact),
      license: entry.license,
      activity: entry.activity,
      security: entry.security,
      withdrawal: entry.withdrawal,
      provenance: entry.provenance,
      selectionContext,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      stateFingerprint: stateFingerprint(entry, input.artifact),
    };
    this.prune(issuedAt.valueOf());
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
    this.tickets.set(token, { claims, used: false, revoked: false });
    return { token, expiresAt: claims.expiresAt };
  }

  verify(
    input: MossMarketplaceSelectionTicketVerifyInput,
    options: MossMarketplaceSelectionTicketVerifyOptions = {},
  ): ProviderCatalogSelectionTicketClaims {
    if (!hasAuthenticatedContext(input.authenticatedActorId, input.selectionContext)) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_AUTH_REQUIRED");
    }
    const stored = this.tickets.get(input.token);
    if (!stored) throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_INVALID");
    const nowMs = this.now().valueOf();
    if (new Date(stored.claims.expiresAt).valueOf() <= nowMs) {
      this.tickets.delete(input.token);
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_EXPIRED");
    }
    if (stored.revoked) throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_REVOKED");
    if (stored.used) throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_USED");
    if (!sameContext(stored.claims.selectionContext, input.selectionContext)) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_CONTEXT_MISMATCH");
    }
    validateArtifact(input.artifact, this.artifactUrlAllowed);
    if (
      JSON.stringify(normalizedArtifact(input.artifact)) !== JSON.stringify(stored.claims.artifact)
    ) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_STATE_CHANGED");
    }
    if (
      !input.currentEntry ||
      input.currentEntry.id !== stored.claims.identity ||
      input.currentEntry.kind !== stored.claims.kind ||
      input.currentEntry.withdrawal ||
      input.currentEntry.security.status === "blocked" ||
      stateFingerprint(input.currentEntry, input.artifact) !== stored.claims.stateFingerprint
    ) {
      throw new MossMarketplaceSelectionTicketError("SELECTION_TICKET_STATE_CHANGED");
    }
    if (options.consume !== false) stored.used = true;
    return stored.claims;
  }

  revoke(token: string): boolean {
    const stored = this.tickets.get(token);
    if (!stored) return false;
    stored.revoked = true;
    return true;
  }

  revokeIdentity(identity: string): number {
    let revoked = 0;
    for (const stored of this.tickets.values()) {
      if (stored.claims.identity === identity && !stored.revoked) {
        stored.revoked = true;
        revoked += 1;
      }
    }
    return revoked;
  }

  prune(nowMs = this.now().valueOf()): number {
    let removed = 0;
    for (const [token, stored] of this.tickets) {
      if (new Date(stored.claims.expiresAt).valueOf() <= nowMs) {
        this.tickets.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}
