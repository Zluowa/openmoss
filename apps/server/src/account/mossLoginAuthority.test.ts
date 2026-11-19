import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMossLoginCredential } from "./mossLoginAuthority";

afterEach(() => vi.unstubAllEnvs());
const token = (sub: string) =>
  `fake.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.fake`;
const urls = {
  cn: "https://cn.example/functions/v1/moss-model-gateway",
  global: "https://global.example/functions/v1/moss-model-gateway",
};
function fixture(active: "cn" | "global" | null = "global") {
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", urls.cn);
  vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", urls.global);
  const phoneState = {
    authenticated: true,
    session: { user: { id: "phone-a" } },
    activeRealm: active,
  };
  const cloudState = { authenticated: true, account: { id: "google-a" }, activeRealm: active };
  const phoneCredential = {
    realm: "memfire-phone",
    accessToken: token("phone-a"),
    gatewayBaseUrl: urls.cn,
  };
  const cloudCredential = {
    realm: "supabase-google",
    accessToken: token("google-a"),
    gatewayBaseUrl: urls.global,
  };
  const phone = {
    getSession: vi.fn(() => Effect.succeed(phoneState)),
    getAuthorityCredential: vi.fn(() => Effect.succeed(phoneCredential)),
  };
  const cloud = {
    getState: vi.fn(() => Effect.succeed(cloudState)),
    getAuthorityCredential: vi.fn(() => Effect.succeed(cloudCredential)),
  };
  const run = () => Effect.runPromise(resolveMossLoginCredential({ phone, cloud } as never));
  return { phone, cloud, phoneState, cloudState, phoneCredential, cloudCredential, run };
}
describe("selected Moss login authority for Apps", () => {
  it.each(["cn", "global"] as const)(
    "uses only the explicitly active %s account",
    async (active) => {
      const f = fixture(active);
      const result = await f.run();
      expect(result.account.id).toBe(active === "cn" ? "phone-a" : "google-a");
      expect(
        active === "cn" ? f.cloud.getAuthorityCredential : f.phone.getAuthorityCredential,
      ).not.toHaveBeenCalled();
    },
  );
  // The account menu (resolveSidebarAccountLane) shows the phone account as current when both
  // are signed in and neither realm provides the models: after signing in to a second account
  // whose lane could not be set up, or before a restarted server has set its lane up again.
  it("uses the phone account the account menu shows when both are signed in and none is active", async () => {
    const f = fixture(null);
    await expect(f.run()).resolves.toMatchObject({ account: { id: "phone-a" } });
    expect(f.cloud.getAuthorityCredential).not.toHaveBeenCalled();
  });
  it("uses the signed-in phone account when the Google realm is still marked active after its sign-in lapsed", async () => {
    const f = fixture("global");
    f.cloudState.authenticated = false;
    await expect(f.run()).resolves.toMatchObject({ account: { id: "phone-a" } });
    expect(f.cloud.getAuthorityCredential).not.toHaveBeenCalled();
  });
  it("uses the signed-in Google account when the phone realm is still marked active after its sign-in lapsed", async () => {
    const f = fixture("cn");
    f.phoneState.authenticated = false;
    await expect(f.run()).resolves.toMatchObject({ account: { id: "google-a" } });
    expect(f.phone.getAuthorityCredential).not.toHaveBeenCalled();
  });
  it("uses the active Google account over a signed-in phone account, as the account menu does", async () => {
    const f = fixture("global");
    await expect(f.run()).resolves.toMatchObject({ account: { id: "google-a" } });
  });
  it("asks for a login only when no account is signed in", async () => {
    const f = fixture(null);
    f.phoneState.authenticated = false;
    f.cloudState.authenticated = false;
    await expect(f.run()).rejects.toMatchObject({
      code: "authentication_required",
      reason: "no-signed-in-account",
    });
  });
  it("names the check that failed for a signed-in account", async () => {
    const f = fixture("global");
    f.cloud.getAuthorityCredential.mockImplementation(
      () => Effect.fail(new Error("refresh in progress")) as never,
    );
    await expect(f.run()).rejects.toMatchObject({
      code: "account_recovery_required",
      reason: "credential-unavailable",
    });
  });
  it("does not choose a cached account when reading the other authority fails", async () => {
    const f = fixture();
    f.phone.getSession.mockImplementation(() => Effect.fail(new Error("failed")) as never);
    await expect(f.run()).rejects.toMatchObject({ code: "account_recovery_required" });
    expect(f.cloud.getAuthorityCredential).not.toHaveBeenCalled();
  });
  it.each(["subject", "realm", "gateway", "header"])(
    "rejects a mismatched %s credential",
    async (which) => {
      const f = fixture();
      if (which === "subject") f.cloudCredential.accessToken = token("other");
      if (which === "realm") f.cloudCredential.realm = "memfire-phone";
      if (which === "gateway") f.cloudCredential.gatewayBaseUrl = urls.cn;
      if (which === "header") f.cloudCredential.accessToken += "\r\ninjected";
      await expect(f.run()).rejects.toMatchObject({ code: "account_recovery_required" });
    },
  );
  it("forwards reportGatewayConnectionFailure only to a trusted fallback entry", async () => {
    const f = fixture("cn");
    const fallback = "https://cn-fallback.example/functions/v1/moss-model-gateway/v1";
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS", fallback);
    let next = fallback;
    Object.assign(f.phoneCredential, {
      reportGatewayConnectionFailure: async () => next,
    });
    const result = await f.run();
    expect(result.reportGatewayConnectionFailure).toBeTypeOf("function");
    await expect(result.reportGatewayConnectionFailure!(urls.cn)).resolves.toBe(fallback);
    next = "https://untrusted.example/functions/v1/moss-model-gateway/v1";
    await expect(result.reportGatewayConnectionFailure!(urls.cn)).resolves.toBe(urls.cn);
  });
});
