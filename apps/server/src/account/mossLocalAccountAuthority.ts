import type { MossManagedGatewayAuthority } from "../provider/mossManagedGatewayTrust";

/** Server-owned identity for local data. This grants no cloud or supplier access. */
export interface MossLocalAccountAuthority {
  readonly realm: MossManagedGatewayAuthority;
  readonly gatewayBaseUrl: string;
  readonly account: {
    readonly id: string;
    readonly realm: MossManagedGatewayAuthority;
  };
  readonly displayName?: string | null;
  readonly phoneNumber?: string;
}

export interface MossLocalAccountAuthorityState {
  readonly activeRealm?: "cn" | "global";
  readonly identity: MossLocalAccountAuthority | null;
}
