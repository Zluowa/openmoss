import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { MossManagedGatewayAuthority } from "../../provider/mossManagedGatewayTrust";
import type { MossCloudAccountServiceError } from "../mossCloudAccountErrors";

export type MossManagedSelectionPolicy = "select" | "preserve";

export interface MossManagedProviderShape {
  /** Whether a credential-bearing or conflicting reserved surface still requires teardown. */
  readonly needsDisable: () => Effect.Effect<boolean, MossCloudAccountServiceError>;
  /** Classifies the exact managed surfaces without claiming or mutating their ownership. */
  readonly getProvisioningState: (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly accessToken: string;
    readonly gatewayBaseUrl: string;
  }) => Effect.Effect<
    "ready" | "stale" | "recoverable-stale" | "collision",
    MossCloudAccountServiceError
  >;
  readonly provision: (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly accessToken: string;
    readonly gatewayBaseUrl: string;
    readonly models?: ReadonlyArray<string>;
    /** Coordinator-owned proof for retiring a previous credential generation after a crash. */
    readonly cleanupAccessTokenHash?: string;
    /**
     * Coordinator-owned proof that the durable active binding still belongs
     * to this authority and hashes to `accessToken`. The provider must still
     * revalidate the exact paired managed tombstone before using this fence.
     */
    readonly recoverStalePairedGeneration?: true;
    /** Explicit login selects Moss; restore/refresh preserves the user's current Codex account. */
    readonly selectionPolicy: MossManagedSelectionPolicy;
  }) => Effect.Effect<void, MossCloudAccountServiceError>;
  readonly disable: (input?: {
    /** Cleanup proof for a credential-bearing generation persisted under an older gateway URL. */
    readonly expectedAccessToken?: string;
    /**
     * Collision-only proof used by forced account cleanup. Structural managed
     * ownership remains preferred so a rotated session token cannot make an
     * otherwise verified cleanup stricter.
     */
    readonly cleanupFallbackAccessToken?: string;
  }) => Effect.Effect<void, MossCloudAccountServiceError>;
}

export class MossManagedProvider extends ServiceMap.Service<
  MossManagedProvider,
  MossManagedProviderShape
>()("moss/account/Services/MossManagedProvider") {}
