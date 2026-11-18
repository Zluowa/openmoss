// FILE: mossLoginAuthority.ts
// Purpose: Resolve the phone/global login Apps uses: the account the account menu shows as
//          current, never another saved one.
// Layer: Server account authority for Apps; reuses the existing account protocol.
import { Effect } from "effect";
import type { MossCloudAccountServiceShape } from "./Services/MossCloudAccountService";
import type { MossPhoneAccountServiceShape } from "./Services/MossPhoneAccountService";
import { isTrustedMossManagedGatewayUrlForAuthority } from "../provider/mossManagedGatewayTrust";

/** Which check failed, for the server log only: no account id, token or address. */
export type MossLoginAuthorityReason =
  | "no-signed-in-account"
  | "account-read-failed"
  | "credential-unavailable"
  | "credential-rejected"
  | "subject-mismatch";

export class MossLoginAuthorityError extends Error {
  constructor(
    readonly code: "authentication_required" | "account_recovery_required",
    readonly reason: MossLoginAuthorityReason,
  ) {
    super(code);
  }
}

export interface MossLoginCredential {
  readonly realm: "memfire-phone" | "supabase-google";
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly account: { readonly id: string; readonly realm: "memfire-phone" | "supabase-google" };
}

export const resolveMossLoginCredential = (input: {
  readonly phone: Pick<MossPhoneAccountServiceShape, "getSession" | "getAuthorityCredential">;
  readonly cloud: Pick<MossCloudAccountServiceShape, "getState" | "getAuthorityCredential">;
}) =>
  Effect.gen(function* () {
    const [phoneResult, cloudResult] = yield* Effect.all([
      Effect.result(input.phone.getSession()),
      Effect.result(input.cloud.getState()),
    ]);
    if (phoneResult._tag === "Failure" || cloudResult._tag === "Failure")
      return yield* Effect.fail(
        new MossLoginAuthorityError("account_recovery_required", "account-read-failed"),
      );
    const phoneState = phoneResult.success;
    const cloudState = cloudResult.success;
    const phoneReady = phoneState.authenticated === true && phoneState.session !== null;
    const cloudReady = cloudState.authenticated === true && cloudState.account !== null;
    if (!phoneReady && !cloudReady)
      return yield* Effect.fail(
        new MossLoginAuthorityError("authentication_required", "no-signed-in-account"),
      );
    // The account the account menu shows as current (`resolveSidebarAccountLane`): the signed-in
    // account whose realm provides the models; while none does, the signed-in phone account,
    // then the Google one. A realm marked active on an account that is not signed in (a lapsed
    // session, a provider still owned by the other account) does not make Apps ask for a login
    // while the person is signed in to the other one.
    const activeGlobal = cloudState.activeRealm === "global" || phoneState.activeRealm === "global";
    const useCloud = (cloudReady && activeGlobal) || !phoneReady;
    const accountId = useCloud ? cloudState.account!.id : phoneState.session!.user.id;
    const recoveryError = () =>
      new MossLoginAuthorityError("account_recovery_required", "credential-unavailable");
    const credential = useCloud
      ? yield* input.cloud.getAuthorityCredential().pipe(Effect.mapError(recoveryError))
      : yield* input.phone.getAuthorityCredential().pipe(Effect.mapError(recoveryError));
    if (
      credential.realm !== (useCloud ? "supabase-google" : "memfire-phone") ||
      !credential.accessToken.trim() ||
      /[\r\n]/u.test(credential.accessToken) ||
      !isTrustedMossManagedGatewayUrlForAuthority(
        credential.gatewayBaseUrl,
        credential.realm,
        process.env,
      )
    )
      return yield* Effect.fail(
        new MossLoginAuthorityError("account_recovery_required", "credential-rejected"),
      );
    // Auth is verified by the account service and again by the gateway. This
    // local subject comparison only closes the selection/token-refresh race.
    const matches = yield* Effect.try({
      try: () =>
        JSON.parse(
          Buffer.from(credential.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
        ).sub === accountId,
      catch: () => new MossLoginAuthorityError("account_recovery_required", "subject-mismatch"),
    });
    if (!matches)
      return yield* Effect.fail(
        new MossLoginAuthorityError("account_recovery_required", "subject-mismatch"),
      );
    return {
      ...credential,
      account: { id: accountId, realm: credential.realm },
    } satisfies MossLoginCredential;
  });
