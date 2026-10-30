import { codexAccountInstanceId } from "@synara/shared/providerInstances";
import { Effect, Option } from "effect";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import {
  MossMediaJobsError,
  MossMediaJobsService,
  type MossMediaCredential,
} from "./mossMediaJobsService";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { isTrustedMossManagedGatewayUrlForAuthority } from "./provider/mossManagedGatewayTrust";
import type { MossLocalAccountAuthority } from "./account/mossLocalAccountAuthority";

const services = new Map<string, MossMediaJobsService>();
const MODEL_PLUGINS: Readonly<Record<string, string>> = {
  "gpt-image-2-official": "moss-imagegen",
  "gpt-image-2.5-flare": "moss-imagegen",
  "gpt-image-2.5-sunburst": "moss-imagegen",
  "nano-banana-pro": "moss-nano-banana",
  "gemini-flash-image": "moss-nano-banana-2",
  "grok-imagine-image-2.0": "moss-grok-image",
  "wan2.7-image-pro": "moss-wan-image",
  "seedream-5-0": "moss-seedream",
  "kling-v3-omni": "moss-kling",
  "wan3.0-video": "moss-wan-video",
  "wan3.0-video-prime": "moss-wan-video",
  happyhorse: "moss-happyhorse",
  "happyhorse-video-edit": "moss-happyhorse",
  "doubao-seedance-2.0": "moss-seedance",
  "doubao-seedance-2.0-fast": "moss-seedance",
  "doubao-seedance-2.5": "moss-seedance",
  "MiniMax-H3": "moss-minimax-h3",
  "MiniMax-H3-Max": "moss-minimax-h3",
};

export function mossMediaJobsServiceFor(stateDirectory: string): MossMediaJobsService {
  let service = services.get(stateDirectory);
  if (!service) {
    service = new MossMediaJobsService({ stateDirectory });
    services.set(stateDirectory, service);
  }
  return service;
}

/**
 * The enterprise key's media identity while it owns the managed surface. Its
 * usage is reserved against the key's enterprise account at the gateway.
 */
const resolveActiveEnterpriseMediaCredential = Effect.gen(function* () {
  const enterprise = yield* MossEnterpriseKeyAccount;
  const result = yield* Effect.result(enterprise.getActiveAuthorityCredential());
  if (result._tag === "Failure")
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  const credential = result.success;
  if (!credential) return null;
  if (
    /[\r\n]/u.test(credential.accessToken) ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      credential.gatewayBaseUrl,
      credential.realm,
      process.env,
    )
  )
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  return {
    realm: credential.realm,
    accessToken: credential.accessToken,
    gatewayBaseUrl: credential.gatewayBaseUrl,
    account: { id: credential.accountId, realm: credential.realm },
  } satisfies MossMediaCredential;
});

/** Local owner documents need a verified identity, never a refreshable cloud bearer. */
export const resolveMossMediaIdentity = Effect.gen(function* () {
  const enterprise = yield* resolveActiveEnterpriseMediaCredential;
  if (enterprise) {
    return {
      realm: enterprise.realm,
      gatewayBaseUrl: enterprise.gatewayBaseUrl,
      account: enterprise.account,
    } satisfies MossLocalAccountAuthority;
  }
  const phone = yield* MossPhoneAccountService;
  const cloud = yield* MossCloudAccountService;
  const [phoneResult, cloudResult] = yield* Effect.all([
    Effect.result(phone.getLocalAuthority()),
    Effect.result(cloud.getLocalAuthority()),
  ]);
  // A failed local read is not permission to choose the other saved account.
  if (phoneResult._tag === "Failure" || cloudResult._tag === "Failure")
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  const phoneState = phoneResult.success;
  const cloudState = cloudResult.success;
  const global = phoneState.activeRealm === "global" || cloudState.activeRealm === "global";
  const cn = phoneState.activeRealm === "cn" || cloudState.activeRealm === "cn";
  if (global && cn)
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  const identity: MossLocalAccountAuthority | null = global
    ? cloudState.identity
    : cn
      ? phoneState.identity
      : phoneState.identity && !cloudState.identity
        ? phoneState.identity
        : cloudState.identity && !phoneState.identity
          ? cloudState.identity
          : null;
  if (!identity) return yield* Effect.fail(new MossMediaJobsError("authentication_required", 401));
  if (
    !identity.account.id ||
    identity.account.realm !== identity.realm ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      identity.gatewayBaseUrl,
      identity.realm,
      process.env,
    )
  )
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  return identity;
});

export const resolveMossMediaCredential = Effect.gen(function* () {
  const enterprise = yield* resolveActiveEnterpriseMediaCredential;
  if (enterprise) return enterprise;
  const phone = yield* MossPhoneAccountService;
  const cloud = yield* MossCloudAccountService;
  const [phoneResult, cloudResult] = yield* Effect.all([
    Effect.result(phone.getSession()),
    Effect.result(cloud.getState()),
  ]);
  const phoneState = phoneResult._tag === "Success" ? phoneResult.success : null;
  const cloudState = cloudResult._tag === "Success" ? cloudResult.success : null;
  const phoneReady = phoneState?.authenticated === true && phoneState.session !== null;
  const cloudReady = cloudState?.authenticated === true && cloudState.account !== null;
  const activeGlobal = cloudState?.activeRealm === "global" || phoneState?.activeRealm === "global";
  const activeCn = phoneState?.activeRealm === "cn" || cloudState?.activeRealm === "cn";
  if (activeGlobal && activeCn)
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  const useCloud = activeGlobal || (!activeCn && cloudReady && !phoneReady);
  const usePhone = activeCn || (!activeGlobal && phoneReady && !cloudReady);
  if ((!useCloud && !usePhone) || (useCloud && !cloudReady) || (usePhone && !phoneReady)) {
    return yield* Effect.fail(new MossMediaJobsError("authentication_required", 401));
  }
  const accountId = useCloud ? cloudState!.account!.id : phoneState!.session!.user.id;
  const credential = useCloud
    ? yield* cloud.getAuthorityCredential()
    : yield* phone.getAuthorityCredential();
  if (
    !credential.accessToken.trim() ||
    /[\r\n]/u.test(credential.accessToken) ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      credential.gatewayBaseUrl,
      credential.realm,
      process.env,
    )
  ) {
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  }
  // The credential was resolved and validated by the account service. Checking
  // its subject closes a state/credential race when an account switches.
  const matchesSubject = yield* Effect.try({
    try: () =>
      JSON.parse(
        Buffer.from(credential.accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
      ).sub === accountId,
    catch: () => new MossMediaJobsError("account_recovery_required", 401),
  });
  if (!matchesSubject)
    return yield* Effect.fail(new MossMediaJobsError("account_recovery_required", 401));
  return {
    ...credential,
    account: { id: accountId, realm: credential.realm },
  } satisfies MossMediaCredential;
});

export const installedMossMediaModels = Effect.gen(function* () {
  const discovery = yield* Effect.serviceOption(ProviderDiscoveryService);
  if (Option.isNone(discovery))
    return yield* Effect.fail(new MossMediaJobsError("media_plugin_discovery_unavailable", 503));
  const result = yield* discovery.value
    .listPlugins({
      provider: "codex",
      instanceId: codexAccountInstanceId("moss"),
    })
    .pipe(Effect.mapError(() => new MossMediaJobsError("media_plugin_discovery_unavailable", 503)));
  if (
    !result.marketplaces.some((marketplace) => marketplace.name === "moss-bundled") &&
    result.marketplaceLoadErrors.length > 0
  ) {
    return yield* Effect.fail(new MossMediaJobsError("media_plugin_discovery_unavailable", 503));
  }
  const installed = new Set(
    result.marketplaces
      .filter((marketplace) => marketplace.name === "moss-bundled")
      .flatMap((marketplace) => marketplace.plugins)
      .filter((plugin) => plugin.installed && plugin.enabled && plugin.availability === "AVAILABLE")
      .map((plugin) => plugin.id),
  );
  return Object.entries(MODEL_PLUGINS)
    .filter(([, plugin]) => installed.has(`${plugin}@moss-bundled`))
    .map(([model]) => model);
});
