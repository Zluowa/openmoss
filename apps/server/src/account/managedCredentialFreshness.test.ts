import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@moss/contracts";
import type { ResolvedProviderInstance } from "@moss/shared/providerInstances";
import {
  managedCredentialRefreshAuthority,
  MOSS_BEARER_REFRESH_LEAD_MS,
  MOSS_BEARER_SEND_ROTATION_LEAD_MS,
  mossBearerRefreshLeadMs,
  mossBearerSendRotationLeadMs,
} from "./managedCredentialFreshness";

const cn = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const global = "https://example.supabase.co/functions/v1/moss-model-gateway/v1";
const env = {
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: cn,
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: global,
};
const now = 1_800_000_000_000;
function instance(exp: number, gatewayBaseUrl = cn): ResolvedProviderInstance {
  return {
    instanceId: ProviderInstanceId.makeUnsafe("codex_moss"),
    driver: "codex",
    displayName: "Moss",
    enabled: true,
    isDefault: false,
    raw: { driver: "codex", enabled: true },
    config: { gatewayBaseUrl },
    environment: {
      OPENAI_API_KEY: `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`,
    },
  };
}
describe("managed credential freshness before dispatch", () => {
  it.each(["grok", "hermes", "kimi", "minimax", "zcode"] as const)(
    "refreshes only the managed %s bearer and leaves personal accounts alone",
    (driver) => {
      const base = instance(0);
      const relay: ResolvedProviderInstance = {
        ...base,
        instanceId: ProviderInstanceId.makeUnsafe(`${driver}_moss`),
        driver,
        raw: { driver, enabled: true },
        environment: {
          MOSS_ACCESS_TOKEN: base.environment.OPENAI_API_KEY!,
          OPENAI_API_KEY: instance(now / 1000 + 3600).environment.OPENAI_API_KEY!,
        },
      };
      expect(managedCredentialRefreshAuthority(relay, env, now)).toBe("memfire-phone");
      expect(
        managedCredentialRefreshAuthority(
          {
            ...relay,
            environment: {
              MOSS_ACCESS_TOKEN: instance(now / 1000 + 3600).environment.OPENAI_API_KEY!,
            },
          },
          env,
          now,
        ),
      ).toBeNull();
      expect(managedCredentialRefreshAuthority({ ...relay, environment: {} }, env, now)).toBe(
        "memfire-phone",
      );
      for (const id of [driver, `${driver}_personal`, `${driver}_moss_other`]) {
        expect(
          managedCredentialRefreshAuthority(
            { ...relay, instanceId: ProviderInstanceId.makeUnsafe(id) },
            env,
            now,
          ),
        ).toBeNull();
      }
    },
  );
  it("rotates before a send only when the bearer could lapse during a long turn", () => {
    expect(MOSS_BEARER_SEND_ROTATION_LEAD_MS).toBe(25 * 60_000);
    // 26 minutes left: a 25-minute turn still finishes on it.
    expect(managedCredentialRefreshAuthority(instance(now / 1000 + 26 * 60), env, now)).toBeNull();
    expect(managedCredentialRefreshAuthority(instance(now / 1000 + 24 * 60), env, now)).toBe(
      "memfire-phone",
    );
  });

  it("scales both leads with the token's own lifetime", () => {
    const jwt = (lifetimeSeconds: number) =>
      `h.${Buffer.from(JSON.stringify({ iat: 1_000, exp: 1_000 + lifetimeSeconds })).toString("base64url")}.s`;
    // A 60-minute token gets the full leads.
    expect(mossBearerRefreshLeadMs(jwt(3_600))).toBe(MOSS_BEARER_REFRESH_LEAD_MS);
    expect(mossBearerSendRotationLeadMs(jwt(3_600))).toBe(MOSS_BEARER_SEND_ROTATION_LEAD_MS);
    // A 20-minute token refreshes at 10 minutes left and rotates under 8 m 20 s, not always.
    expect(mossBearerRefreshLeadMs(jwt(1_200))).toBe(600_000);
    expect(mossBearerSendRotationLeadMs(jwt(1_200))).toBe(500_000);
    // No `iat`, or not a JWT: the fixed leads.
    expect(mossBearerRefreshLeadMs(instance(0).environment.OPENAI_API_KEY)).toBe(
      MOSS_BEARER_REFRESH_LEAD_MS,
    );
    expect(mossBearerSendRotationLeadMs("moss_sk_not_a_jwt")).toBe(
      MOSS_BEARER_SEND_ROTATION_LEAD_MS,
    );
  });

  it("refreshes expired and near-expiry CN credentials but avoids network work for fresh ones", () => {
    expect(managedCredentialRefreshAuthority(instance(now / 1000 - 1), env, now)).toBe(
      "memfire-phone",
    );
    expect(managedCredentialRefreshAuthority(instance(now / 1000 + 299), env, now)).toBe(
      "memfire-phone",
    );
    expect(managedCredentialRefreshAuthority(instance(now / 1000 + 3600), env, now)).toBeNull();
  });
  it.each([
    { remainingMs: -1, refresh: true },
    { remainingMs: 0, refresh: true },
    { remainingMs: 1_499_999, refresh: true },
    { remainingMs: 1_500_000, refresh: true },
    { remainingMs: 1_500_001, refresh: false },
    { remainingMs: 3_600_000, refresh: false },
  ])("uses the Pi Moss bearer expiry at $remainingMs ms remaining", ({ remainingMs, refresh }) => {
    const base = instance((now + remainingMs) / 1000);
    const pi: ResolvedProviderInstance = {
      ...base,
      instanceId: ProviderInstanceId.makeUnsafe("pi_moss"),
      driver: "pi",
      raw: { driver: "pi", enabled: true },
      environment: {
        MOSS_ACCESS_TOKEN: base.environment.OPENAI_API_KEY!,
        // An unrelated upstream credential must never decide Moss freshness.
        OPENAI_API_KEY: instance(refresh ? now / 1000 + 3600 : 0).environment.OPENAI_API_KEY!,
      },
    };
    expect(managedCredentialRefreshAuthority(pi, env, now)).toBe(refresh ? "memfire-phone" : null);
  });

  it("refreshes missing or malformed Pi bearers through their configured realm", () => {
    const base = instance(0, global);
    for (const token of [undefined, "malformed", "header.e30.signature"]) {
      const pi: ResolvedProviderInstance = {
        ...base,
        instanceId: ProviderInstanceId.makeUnsafe("pi_moss"),
        driver: "pi",
        raw: { driver: "pi", enabled: true },
        environment: token === undefined ? {} : { MOSS_ACCESS_TOKEN: token },
      };
      expect(managedCredentialRefreshAuthority(pi, env, now)).toBe("supabase-google");
    }
  });

  it.each(["pi", "pi_personal", "pi_moss_other", "other_pi_moss"])(
    "does not refresh a personal or similarly named Pi instance: %s",
    (instanceId) => {
      const pi: ResolvedProviderInstance = {
        ...instance(0),
        instanceId: ProviderInstanceId.makeUnsafe(instanceId),
        driver: "pi",
        raw: { driver: "pi", enabled: true },
        environment: { MOSS_ACCESS_TOKEN: instance(0).environment.OPENAI_API_KEY! },
      };
      expect(managedCredentialRefreshAuthority(pi, env, now)).toBeNull();
    },
  );

  it("selects the configured Global authority and reconciles missing credentials", () => {
    const value = instance(now / 1000 - 1, global);
    expect(managedCredentialRefreshAuthority(value, env, now)).toBe("supabase-google");
    expect(managedCredentialRefreshAuthority({ ...value, environment: {} }, env, now)).toBe(
      "supabase-google",
    );
  });
  it("does not switch realms for untrusted or nonmanaged provider instances", () => {
    expect(
      managedCredentialRefreshAuthority(instance(0, "https://attacker.example/v1"), env, now),
    ).toBeNull();
    expect(
      managedCredentialRefreshAuthority(
        { ...instance(0), instanceId: ProviderInstanceId.makeUnsafe("codex") },
        env,
        now,
      ),
    ).toBeNull();
    expect(
      managedCredentialRefreshAuthority({ ...instance(0), enabled: false }, env, now),
    ).toBeNull();
  });
});
