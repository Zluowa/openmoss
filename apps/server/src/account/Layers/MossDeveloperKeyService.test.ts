import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeMossDeveloperKeyService } from "./MossDeveloperKeyService";
import { MossPayError } from "../mossPayGateway";

describe("MossDeveloperKeyService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns signed-out state gracefully without failing when account is unauthorized", async () => {
    const service = makeMossDeveloperKeyService({
      resolveCredential: () =>
        Effect.fail(
          new MossPayError({
            code: "unauthorized",
            message: "not signed in",
          }),
        ),
      localGatewayBaseUrl: "http://127.0.0.1:3773/api/moss/developer/v1",
    });

    const state = await Effect.runPromise(service.getState());
    expect(state).toEqual({
      configured: true,
      authenticated: false,
      gatewayBaseUrl: null,
      localGatewayBaseUrl: "http://127.0.0.1:3773/api/moss/developer/v1",
      wallet: null,
      breakdown: [],
      keys: [],
      recentLedger: [],
    });
  });

  it("lists, creates, and revokes developer keys against the authenticated authority", async () => {
    const gatewayUrl = "https://cn-gateway.example.test/functions/v1/moss-model-gateway/v1";
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gatewayUrl);
    const secret = `moss_dk_cn_${"k".repeat(32)}`;
    const payFetch = vi.fn(async (input: { method: string; path: string }) => {
      if (input.method === "GET" && input.path === "/developer/keys") {
        return {
          wallet: {
            initial_grant_fen: 300,
            available_fen: 280,
            held_fen: 0,
            spent_fen: 20,
            available_nano_cny: "2800000000",
            held_nano_cny: "0",
            spent_nano_cny: "200000000",
          },
          keys: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Production CLI",
              key_prefix: secret.slice(0, 15),
              scopes: ["llm", "image", "video", "voice"],
              status: "active",
              last_used_at: null,
              revoked_at: null,
              created_at: "2026-11-27T00:00:00.000Z",
            },
          ],
        };
      }
      if (input.method === "GET" && input.path === "/developer/quota") {
        return {
          wallet: {
            initial_grant_fen: 300,
            available_fen: 280,
            held_fen: 0,
            spent_fen: 20,
            available_nano_cny: "2800000000",
            held_nano_cny: "0",
            spent_nano_cny: "200000000",
          },
          breakdown: [
            { capability: "llm", request_count: 2, spent_nano_cny: "200000000" },
            { capability: "voice", request_count: 0, spent_nano_cny: "0" },
          ],
          recent_ledger: [],
        };
      }
      if (input.method === "POST" && input.path === "/developer/keys") {
        return {
          key: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "New Bot",
            key_prefix: secret.slice(0, 15),
            scopes: ["llm", "voice"],
            status: "active",
            last_used_at: null,
            revoked_at: null,
            created_at: "2026-11-27T00:05:00.000Z",
          },
          api_key: secret,
          wallet: {
            initial_grant_fen: 300,
            available_fen: 280,
            held_fen: 0,
            spent_fen: 20,
            available_nano_cny: "2800000000",
            held_nano_cny: "0",
            spent_nano_cny: "200000000",
          },
        };
      }
      if (input.method === "POST" && input.path.endsWith("/revoke")) {
        return {
          revoked: true,
          key: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "New Bot",
            key_prefix: secret.slice(0, 15),
            scopes: ["llm", "voice"],
            status: "revoked",
            last_used_at: null,
            revoked_at: "2026-11-27T00:06:00.000Z",
            created_at: "2026-11-27T00:05:00.000Z",
          },
        };
      }
      return {};
    });

    const service = makeMossDeveloperKeyService({
      resolveCredential: () =>
        Effect.succeed({
          realm: "memfire-phone",
          gatewayBaseUrl: gatewayUrl,
          accessToken: "session-jwt",
          realtimeRelayUrl: "https://cn-relay.example.test",
          account: {
            id: "61616161-6161-4161-8161-616161616161",
            phone: "+8613800000011",
          },
        } as unknown as Parameters<
          typeof makeMossDeveloperKeyService
        >[0]["resolveCredential"] extends () => Effect.Effect<infer C, MossPayError>
          ? C
          : never),
      payFetch: (input) => payFetch(input),
      localGatewayBaseUrl: "http://127.0.0.1:3773/api/moss/developer/v1",
    });

    const state = await Effect.runPromise(service.getState());
    expect(state.authenticated).toBe(true);
    expect(state.wallet?.availableFen).toBe(280);
    expect(state.keys).toHaveLength(1);
    expect(state.breakdown).toHaveLength(2);

    const created = await Effect.runPromise(
      service.createKey({ name: "New Bot", scopes: ["llm", "voice"] }),
    );
    expect(created.secretKey).toBe(secret);
    expect(created.key.scopes).toEqual(["llm", "voice"]);

    const revoked = await Effect.runPromise(
      service.revokeKey({ keyId: "22222222-2222-4222-8222-222222222222" }),
    );
    expect(revoked.revoked).toBe(true);
    expect(revoked.key?.status).toBe("revoked");
  });
});
