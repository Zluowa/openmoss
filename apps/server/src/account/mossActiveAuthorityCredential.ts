// FILE: mossActiveAuthorityCredential.ts
// Purpose: One rule for which sign-in pays for Moss-owned services beside the
// managed engines (voice notes, realtime voice, Canvas, media): an enterprise
// key that owns the managed surface wins; otherwise each caller keeps its own
// phone/Google selection.
// Layer: account (server).
import {
  MOSS_ACCESS_LANE_SPECS,
  mossAccessLaneForAuthority,
  type MossRealm,
} from "@synara/shared/mossRealmCatalog";
import { Effect } from "effect";

import type { MossManagedGatewayAuthority } from "../provider/mossManagedGatewayTrust";
import type { MossSupabaseGoogleAuthorityCredential } from "./Services/MossCloudAccountService";
import type {
  MossEnterpriseKeyAccountShape,
  MossEnterpriseKeyAuthorityCredential,
  MossEnterpriseKeyError,
} from "./Services/MossEnterpriseKeyAccount";
import type { MossMemFirePhoneAuthorityCredential } from "./Services/MossPhoneAccountService";

export type MossAuthorityCredential =
  | MossMemFirePhoneAuthorityCredential
  | MossSupabaseGoogleAuthorityCredential
  | MossEnterpriseKeyAuthorityCredential;

export type MossActiveEnterpriseKeySource = Pick<
  MossEnterpriseKeyAccountShape,
  "getActiveAuthorityCredential"
>;

/** `accountCredential` is only built when no enterprise key owns the surface. */
export function preferActiveEnterpriseKeyCredential<A, E, R>(
  enterprise: MossActiveEnterpriseKeySource | undefined,
  accountCredential: () => Effect.Effect<A, E, R>,
): Effect.Effect<A | MossEnterpriseKeyAuthorityCredential, E | MossEnterpriseKeyError, R> {
  if (!enterprise) return Effect.suspend(accountCredential);
  return enterprise
    .getActiveAuthorityCredential()
    .pipe(
      Effect.flatMap(
        (credential): Effect.Effect<A | MossEnterpriseKeyAuthorityCredential, E, R> =>
          credential ? Effect.succeed(credential) : accountCredential(),
      ),
    );
}

/** Regional control plane (and relay) that serves an authority's bearer. */
export function mossCloudRegionForAuthority(authority: MossManagedGatewayAuthority): MossRealm {
  return MOSS_ACCESS_LANE_SPECS[mossAccessLaneForAuthority(authority)].realm;
}
