// FILE: mossLoginAuthority.ts
// Purpose: Resolve the selected phone/global login without falling back to another saved account.
// Layer: Server account authority for Apps; reuses the existing account protocol.
import { Effect } from "effect";
import type { MossCloudAccountServiceShape } from "./Services/MossCloudAccountService";
import type { MossPhoneAccountServiceShape } from "./Services/MossPhoneAccountService";
import { isTrustedMossManagedGatewayUrlForAuthority } from "../provider/mossManagedGatewayTrust";

export class MossLoginAuthorityError extends Error {
  constructor(readonly code: "authentication_required" | "account_recovery_required") {
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
      return yield* Effect.fail(new MossLoginAuthorityError("account_recovery_required"));
    const phoneState = phoneResult.success;
    const cloudState = cloudResult.success;
    const phoneReady = phoneState.authenticated === true && phoneState.session !== null;
    const cloudReady = cloudState.authenticated === true && cloudState.account !== null;
    const activeGlobal = cloudState.activeRealm === "global" || phoneState.activeRealm === "global";
    const activeCn = phoneState.activeRealm === "cn" || cloudState.activeRealm === "cn";
    if (activeGlobal && activeCn)
      return yield* Effect.fail(new MossLoginAuthorityError("account_recovery_required"));
    const useCloud = activeGlobal || (!activeCn && cloudReady && !phoneReady);
    const usePhone = activeCn || (!activeGlobal && phoneReady && !cloudReady);
    if ((!useCloud && !usePhone) || (useCloud && !cloudReady) || (usePhone && !phoneReady))
      return yield* Effect.fail(new MossLoginAuthorityError("authentication_required"));
    const accountId = useCloud ? cloudState.account!.id : phoneState.session!.user.id;
    const recoveryError = () => new MossLoginAuthorityError("account_recovery_required");
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
      return yield* Effect.fail(new MossLoginAuthorityError("account_recovery_required"));
    // Auth is verified by the account service and again by the gateway. This
    // local subject comparison only closes the selection/token-refresh race.
    const matches = yield* Effect.try({
      try: () =>
        JSON.parse(
          Buffer.from(credential.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
        ).sub === accountId,
      catch: () => new MossLoginAuthorityError("account_recovery_required"),
    });
    if (!matches)
      return yield* Effect.fail(new MossLoginAuthorityError("account_recovery_required"));
    return {
      ...credential,
      account: { id: accountId, realm: credential.realm },
    } satisfies MossLoginCredential;
  });
