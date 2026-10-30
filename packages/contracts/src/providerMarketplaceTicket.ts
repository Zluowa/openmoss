// FILE: providerMarketplaceTicket.ts
// Purpose: Metadata-only catalog selection attestations shared by catalog and
//          the later explicit import flow. Tokens are opaque handles; claims
//          never contain secrets, commands, or executable content.

import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import {
  ProviderCatalogActivity,
  ProviderCatalogLicense,
  ProviderCatalogProvenance,
  ProviderCatalogResourceKind,
  ProviderCatalogSecurity,
  ProviderCatalogSourceTier,
  ProviderCatalogWithdrawal,
} from "./providerDiscovery";

const TicketToken = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ArtifactUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)).check(
  Schema.isPattern(/^https:\/\/[^\s]+$/i),
);
const ArtifactHash = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-f0-9]{64}$/i));

export const ProviderCatalogSelectionContext = Schema.Struct({
  actionId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  actorId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  selectedAt: Schema.String,
});
export type ProviderCatalogSelectionContext = typeof ProviderCatalogSelectionContext.Type;

/** Catalog selection RPC input. Actor, root, artifact and digest are server-bound. */
export const MossCatalogSelectionInput = Schema.Struct({
  kind: ProviderCatalogResourceKind,
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type MossCatalogSelectionInput = typeof MossCatalogSelectionInput.Type;

export const MossCatalogSelectionResult = Schema.Struct({
  token: TicketToken,
  expiresAt: Schema.String,
});
export type MossCatalogSelectionResult = typeof MossCatalogSelectionResult.Type;

export const ProviderCatalogArtifactLocator = Schema.Struct({
  url: ArtifactUrl,
  sha256: ArtifactHash,
});
export type ProviderCatalogArtifactLocator = typeof ProviderCatalogArtifactLocator.Type;

export const ProviderCatalogSelectionTicket = Schema.Struct({
  token: TicketToken,
  expiresAt: Schema.String,
});
export type ProviderCatalogSelectionTicket = typeof ProviderCatalogSelectionTicket.Type;

export const ProviderCatalogSelectionTicketClaims = Schema.Struct({
  identity: TrimmedNonEmptyString,
  kind: ProviderCatalogResourceKind,
  authoritativeSourceId: TrimmedNonEmptyString,
  authoritativeSourceTier: ProviderCatalogSourceTier,
  sourceVersion: Schema.NullOr(TrimmedNonEmptyString),
  generation: NonNegativeInt,
  snapshot: TrimmedNonEmptyString,
  artifact: Schema.NullOr(ProviderCatalogArtifactLocator),
  license: ProviderCatalogLicense,
  activity: ProviderCatalogActivity,
  security: ProviderCatalogSecurity,
  withdrawal: Schema.NullOr(ProviderCatalogWithdrawal),
  provenance: ProviderCatalogProvenance,
  selectionContext: ProviderCatalogSelectionContext,
  issuedAt: Schema.String,
  expiresAt: Schema.String,
  stateFingerprint: TrimmedNonEmptyString,
});
export type ProviderCatalogSelectionTicketClaims = typeof ProviderCatalogSelectionTicketClaims.Type;
