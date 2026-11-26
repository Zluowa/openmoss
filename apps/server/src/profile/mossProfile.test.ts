import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import {
  MOSS_PROFILE_AVATAR_MAX_BYTES,
  MOSS_PROFILE_ERROR_CODES,
  MossProfileDisplayName,
  MossProfileHandle,
  MossProfileUpdateInput,
  WsRpcError,
} from "@moss/contracts";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MOSS_PROFILE_STORE_FILE,
  decodeAvatarUpload,
  defaultDisplayName,
  handleFormatStatus,
  makeMossProfileService,
  normalizeHandleInput,
  type MossProfileServiceOptions,
} from "./mossProfile";

const USER_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const GLOBAL_URL = "https://moss-test.supabase.co";
const CN_URL = "https://moss-test.memfiredb.com";
// A JWT-shaped bearer whose subject is the account, built at run time.
const accessToken = (sub: string) =>
  [{ alg: "none" }, { sub }, "signature"]
    .map((part) =>
      Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url"),
    )
    .join(".");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]).toString("base64");
const ENV = {
  MOSS_SUPABASE_GOOGLE_URL: GLOBAL_URL,
  MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: "publishable-global",
  MOSS_MEMFIRE_PHONE_URL: CN_URL,
  MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "publishable-cn",
};

interface Row {
  display_name: string;
  handle: string | null;
  avatar_kind: string;
  avatar_ref: string | null;
  updated_at: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// One realm's PostgREST and Storage, as far as the profile uses them.
function fakeRealm() {
  const realm = {
    online: true,
    row: null as Row | null,
    takenHandles: new Set<string>(["taken_one"]),
    uploads: [] as Array<{ url: string; contentType: string | null; bytes: number }>,
    origins: new Set<string>(),
    clock: Date.parse("2026-11-21T08:00:00.000Z"),
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!realm.online) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    realm.origins.add(url.origin);
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("Bearer ") || !headers.get("apikey")) {
      return json(401, { message: "unauthorized" });
    }
    if (url.pathname === "/rest/v1/moss_profiles" && init?.method === "GET") {
      return json(200, realm.row ? [realm.row] : []);
    }
    if (url.pathname === "/rest/v1/rpc/moss_check_handle_available") {
      const { p_handle } = JSON.parse(String(init?.body)) as { p_handle: string };
      return json(200, !realm.takenHandles.has(p_handle));
    }
    if (url.pathname === "/rest/v1/rpc/moss_save_my_profile") {
      const args = JSON.parse(String(init?.body)) as Record<string, string | null>;
      if (args.p_handle && realm.takenHandles.has(args.p_handle)) {
        return json(409, { code: "23505", message: "duplicate key" });
      }
      realm.clock += 1000;
      realm.row = {
        display_name: args.p_display_name!,
        handle: args.p_handle ?? null,
        avatar_kind: args.p_avatar_kind!,
        avatar_ref: args.p_avatar_ref ?? null,
        updated_at: new Date(realm.clock).toISOString(),
      };
      return json(200, { user_id: USER_ID, ...realm.row, created_at: realm.row.updated_at });
    }
    if (url.pathname.startsWith("/storage/v1/object/moss-avatars/") && init?.method === "POST") {
      realm.uploads.push({
        url: url.pathname,
        contentType: headers.get("content-type"),
        bytes: (init.body as Uint8Array).byteLength,
      });
      return json(200, { Key: url.pathname });
    }
    return json(404, { code: "PGRST205" });
  }) as typeof globalThis.fetch;
  return { realm, fetch };
}

const signedOut = { getLocalAuthority: () => Effect.succeed({ identity: null }) };
const notSignedIn = () =>
  Effect.fail(new Error("authentication_required")) as unknown as Effect.Effect<never, never>;

function googleAccount(displayName: string | null = "Ada Lovelace") {
  return {
    getLocalAuthority: () =>
      Effect.succeed({
        activeRealm: "global" as const,
        identity: {
          realm: "supabase-google" as const,
          gatewayBaseUrl: "https://global-gateway.example.test",
          account: { id: "google-account", realm: "supabase-google" as const },
          displayName,
        },
      }),
    getAuthorityCredential: () =>
      Effect.succeed({
        realm: "supabase-google" as const,
        issuer: `${GLOBAL_URL}/auth/v1`,
        accessToken: accessToken(USER_ID),
        gatewayBaseUrl: "https://global-gateway.example.test",
        realtimeRelayUrl: "https://global-realtime.example.test",
      }),
  };
}

function phoneAccount() {
  return {
    getLocalAuthority: () =>
      Effect.succeed({
        identity: {
          realm: "memfire-phone" as const,
          gatewayBaseUrl: "https://cn-gateway.example.test",
          account: { id: "phone-account", realm: "memfire-phone" as const },
          displayName: null,
        },
      }),
    getAuthorityCredential: () =>
      Effect.succeed({
        realm: "memfire-phone" as const,
        issuer: `${CN_URL}/auth/v1`,
        accessToken: accessToken(USER_ID),
        gatewayBaseUrl: "https://cn-gateway.example.test",
        realtimeRelayUrl: "https://cn-realtime.example.test",
      }),
  };
}

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "moss-profile-test-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function service(overrides: Partial<MossProfileServiceOptions> = {}) {
  return Effect.runPromise(
    makeMossProfileService({
      phoneAccount: { ...signedOut, getAuthorityCredential: notSignedIn },
      cloudAccount: { ...signedOut, getAuthorityCredential: notSignedIn },
      stateDir,
      homeDir: nodePath.join(stateDir, "Grace.Hopper"),
      env: ENV,
      ...overrides,
    } as MossProfileServiceOptions),
  );
}

const run = <A>(effect: Effect.Effect<A, WsRpcError>) => Effect.runPromise(effect);
const failure = async (effect: Effect.Effect<unknown, WsRpcError>) => {
  const result = await Effect.runPromise(Effect.flip(effect));
  expect(result).toBeInstanceOf(WsRpcError);
  return result;
};

describe("profile validation rules", () => {
  it("classifies handles the way the database constraint does", () => {
    expect(handleFormatStatus("moss_fan_01")).toBeNull();
    expect(handleFormatStatus("ab")).toBe("too_short");
    expect(handleFormatStatus("a".repeat(21))).toBe("too_long");
    expect(handleFormatStatus("Ada")).toBe("invalid_characters");
    expect(handleFormatStatus("a-b-c")).toBe("invalid_characters");
    expect(handleFormatStatus("admin")).toBe("reserved");
    expect(normalizeHandleInput("  @Ada_99 ")).toBe("ada_99");
  });

  it("decodes only the contract's handles and display names", () => {
    const isHandle = Schema.is(MossProfileHandle);
    expect(isHandle("ada_99")).toBe(true);
    expect(isHandle("support")).toBe(false);
    expect(isHandle("ADA")).toBe(false);
    const decodeName = Schema.decodeUnknownSync(MossProfileDisplayName);
    expect(decodeName("  小苔  ")).toBe("小苔");
    expect(decodeName("苔".repeat(32))).toHaveLength(32);
    expect(() => decodeName("x".repeat(33))).toThrow();
    expect(() => decodeName("   ")).toThrow();
    expect(() => decodeName("a\nb")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MossProfileUpdateInput)({ avatar: { kind: "upload", url: "x" } }),
    ).toThrow();
  });

  it("derives a valid default display name", () => {
    expect(defaultDisplayName(null, "Grace.Hopper")).toBe("Grace.Hopper");
    expect(defaultDisplayName("  ", "\u0007")).toBe("Moss");
    expect([...defaultDisplayName("长".repeat(40))]).toHaveLength(32);
  });

  it("accepts only real PNG, JPEG or WebP pictures up to 1 MB", () => {
    expect(decodeAvatarUpload({ mimeType: "image/png", dataBase64: PNG })).not.toBeNull();
    expect(decodeAvatarUpload({ mimeType: "image/jpeg", dataBase64: PNG })).toBeNull();
    expect(decodeAvatarUpload({ mimeType: "image/png", dataBase64: "not base64!" })).toBeNull();
    const tooLarge = Buffer.alloc(MOSS_PROFILE_AVATAR_MAX_BYTES + 1);
    Buffer.from(PNG, "base64").copy(tooLarge);
    expect(
      decodeAvatarUpload({ mimeType: "image/png", dataBase64: tooLarge.toString("base64") }),
    ).toBeNull();
    const webp = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1").toString("base64");
    expect(decodeAvatarUpload({ mimeType: "image/webp", dataBase64: webp })).not.toBeNull();
  });
});

describe("signed-out local profile", () => {
  it("keeps the profile on this computer without any network call", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({ fetch });
    const initial = await run(profile.get());
    expect(initial).toEqual({
      scope: "local",
      realm: null,
      sync: "local",
      editable: true,
      profile: {
        displayName: "Grace.Hopper",
        handle: "gracehopper",
        avatar: { kind: "initials" },
        updatedAt: null,
      },
    });

    await run(
      profile.update({
        displayName: "格蕾丝",
        handle: "grace",
        avatar: { kind: "preset", id: "leaf-sprout" },
      }),
    );
    expect(await run(profile.checkHandle({ handle: "Grace" }))).toEqual({
      handle: "grace",
      status: "current",
    });
    expect(await run(profile.checkHandle({ handle: "taken_one" }))).toEqual({
      handle: "taken_one",
      status: "available",
    });
    const uploaded = await run(profile.uploadAvatar({ mimeType: "image/png", dataBase64: PNG }));
    expect(uploaded.profile.avatar).toEqual({
      kind: "upload",
      url: `data:image/png;base64,${PNG}`,
    });

    const reopened = await run((await service({ fetch })).get());
    expect(reopened.profile).toMatchObject({ displayName: "格蕾丝", handle: "grace" });
    expect(reopened.profile.avatar.kind).toBe("upload");
    expect(realm.origins.size).toBe(0);
  });

  it("starts over when the local file is unreadable", async () => {
    await fs.writeFile(nodePath.join(stateDir, MOSS_PROFILE_STORE_FILE), "{not json");
    const state = await run((await service()).get());
    expect(state.profile.displayName).toBe("Grace.Hopper");
  });

  it("refuses a picture that is not what it claims", async () => {
    const error = await failure(
      (await service()).uploadAvatar({ mimeType: "image/webp", dataBase64: PNG }),
    );
    expect(error.code).toBe(MOSS_PROFILE_ERROR_CODES.avatarInvalid);
  });
});

describe("signed-in account profile", () => {
  it("reads defaults, saves to the realm and keeps a copy for offline reads", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({ fetch, cloudAccount: googleAccount() });

    const first = await run(profile.get());
    expect(first).toMatchObject({
      scope: "account",
      realm: "global",
      sync: "synced",
      editable: true,
    });
    expect(first.profile).toEqual({
      displayName: "Ada Lovelace",
      handle: null,
      avatar: { kind: "initials" },
      updatedAt: null,
    });

    const saved = await run(
      profile.update({ handle: "ada", avatar: { kind: "preset", id: "cat-nap" } }),
    );
    expect(saved.profile).toMatchObject({
      displayName: "Ada Lovelace",
      handle: "ada",
      avatar: { kind: "preset", id: "cat-nap" },
    });
    // A later patch keeps what it does not name.
    await run(profile.update({ displayName: "阿达" }));
    expect(realm.row).toMatchObject({ display_name: "阿达", handle: "ada", avatar_ref: "cat-nap" });
    expect(realm.origins).toEqual(new Set([GLOBAL_URL]));

    realm.online = false;
    const offline = await run((await service({ fetch, cloudAccount: googleAccount() })).get());
    expect(offline).toMatchObject({ sync: "offline", editable: false });
    expect(offline.profile).toMatchObject({ displayName: "阿达", handle: "ada" });
    const refused = await failure(profile.update({ displayName: "x" }));
    expect(refused.code).toBe(MOSS_PROFILE_ERROR_CODES.offline);
    expect(refused.retryable).toBe(true);
    expect(await run(profile.checkHandle({ handle: "new_one" }))).toEqual({
      handle: "new_one",
      status: "unverified",
    });
    expect(await run(profile.checkHandle({ handle: "ada" }))).toEqual({
      handle: "ada",
      status: "current",
    });
  });

  it("checks uniqueness with the realm and reports a handle taken while saving", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({ fetch, cloudAccount: googleAccount() });
    expect(await run(profile.checkHandle({ handle: "taken_one" }))).toEqual({
      handle: "taken_one",
      status: "taken",
    });
    expect(await run(profile.checkHandle({ handle: "free_one" }))).toEqual({
      handle: "free_one",
      status: "available",
    });
    expect((await run(profile.checkHandle({ handle: "root" }))).status).toBe("reserved");
    const error = await failure(profile.update({ handle: "taken_one" }));
    expect(error.code).toBe(MOSS_PROFILE_ERROR_CODES.handleTaken);
    expect(realm.row).toBeNull();
  });

  it("uploads the picture to the owner's folder and shows its public URL", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({ fetch, cloudAccount: googleAccount() });
    const state = await run(profile.uploadAvatar({ mimeType: "image/png", dataBase64: PNG }));
    expect(realm.uploads).toEqual([
      {
        url: `/storage/v1/object/moss-avatars/${USER_ID}/avatar`,
        contentType: "image/png",
        bytes: 16,
      },
    ]);
    expect(realm.row).toMatchObject({ avatar_kind: "upload", avatar_ref: `${USER_ID}/avatar` });
    expect(state.profile.avatar).toEqual({
      kind: "upload",
      url: `${GLOBAL_URL}/storage/v1/object/public/moss-avatars/${USER_ID}/avatar?v=${Date.parse(realm.row!.updated_at)}`,
    });
  });

  it("uses the phone account's CN realm when a phone account is signed in", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({
      fetch,
      phoneAccount: phoneAccount(),
      cloudAccount: googleAccount(),
    });
    const state = await run(profile.update({ handle: "cn_user" }));
    expect(state).toMatchObject({ realm: "cn", sync: "synced" });
    expect(state.profile.displayName).toBe("Grace.Hopper");
    expect(realm.origins).toEqual(new Set([CN_URL]));
  });

  it("shows defaults offline before the realm was ever reached", async () => {
    const { realm, fetch } = fakeRealm();
    realm.online = false;
    const state = await run((await service({ fetch, cloudAccount: googleAccount(null) })).get());
    expect(state).toMatchObject({ scope: "account", sync: "offline", editable: false });
    expect(state.profile.displayName).toBe("Grace.Hopper");
  });

  it("respects activeRealm=global when both phone and cloud accounts are signed in", async () => {
    const { realm, fetch } = fakeRealm();
    const profile = await service({
      fetch,
      phoneAccount: {
        ...phoneAccount(),
        getSession: () =>
          Effect.succeed({
            authenticated: true,
            activeRealm: "global" as const,
            session: null,
          } as never),
      },
      cloudAccount: {
        ...googleAccount("Ada Global"),
        getState: () =>
          Effect.succeed({
            authenticated: true,
            activeRealm: "global" as const,
            account: { id: "google-account" },
            session: null,
          } as never),
      },
    });
    const state = await run(profile.update({ handle: "ada_global" }));
    expect(state).toMatchObject({ realm: "global", sync: "synced" });
    expect(realm.origins).toEqual(new Set([GLOBAL_URL]));
  });

  it("preserves a cached account or local custom avatar when the remote realm has no row yet", async () => {
    const { realm, fetch } = fakeRealm();
    const localOnly = await service({ fetch });
    await run(localOnly.update({ avatar: { kind: "preset", id: "cat-nap" } }));

    // Signed-in account with empty remote row keeps the customized local avatar instead of initials.
    const signedIn = await service({ fetch, cloudAccount: googleAccount("Ada Lovelace") });
    const first = await run(signedIn.get());
    expect(first.profile.avatar).toEqual({ kind: "preset", id: "cat-nap" });

    // Once saved and cached, an empty remote response still does not reset the cached avatar.
    await run(signedIn.update({ avatar: { kind: "preset", id: "leaf-sprout" } }));
    realm.row = null;
    const afterEmptyRemote = await run(signedIn.get());
    expect(afterEmptyRemote.profile.avatar).toEqual({ kind: "preset", id: "leaf-sprout" });
  });

  it("preserves fallback preset avatar and cached profile fields when updating after an empty remote row", async () => {
    const { realm, fetch } = fakeRealm();
    const localOnly = await service({ fetch });
    await run(localOnly.update({ avatar: { kind: "preset", id: "cat-nap" } }));

    // Empty remote row on first sign-in: editing displayName preserves the fallback preset avatar.
    const signedIn = await service({ fetch, cloudAccount: googleAccount("Ada Lovelace") });
    const initial = await run(signedIn.get());
    expect(initial.profile.avatar).toEqual({ kind: "preset", id: "cat-nap" });

    const updatedName = await run(signedIn.update({ displayName: "阿达" }));
    expect(updatedName.profile).toMatchObject({
      displayName: "阿达",
      handle: null,
      avatar: { kind: "preset", id: "cat-nap" },
    });
    expect(realm.row).toMatchObject({
      display_name: "阿达",
      avatar_kind: "preset",
      avatar_ref: "cat-nap",
    });

    // Cached account profile with handle + preset avatar: if remote row is missing,
    // updating displayName preserves both the cached handle and preset avatar.
    await run(
      signedIn.update({ handle: "ada_saved", avatar: { kind: "preset", id: "leaf-sprout" } }),
    );
    realm.row = null;
    const preservedCached = await run(signedIn.update({ displayName: "阿达新名字" }));
    expect(preservedCached.profile).toMatchObject({
      displayName: "阿达新名字",
      handle: "ada_saved",
      avatar: { kind: "preset", id: "leaf-sprout" },
    });
    expect(realm.row).toMatchObject({
      display_name: "阿达新名字",
      handle: "ada_saved",
      avatar_kind: "preset",
      avatar_ref: "leaf-sprout",
    });
  });

  it("does not write a local data URL upload into remote avatar_ref when updating after an empty remote row", async () => {
    const { realm, fetch } = fakeRealm();
    const localOnly = await service({ fetch });
    const localUploaded = await run(
      localOnly.uploadAvatar({ mimeType: "image/png", dataBase64: PNG }),
    );
    expect(localUploaded.profile.avatar).toEqual({
      kind: "upload",
      url: `data:image/png;base64,${PNG}`,
    });

    const signedIn = await service({ fetch, cloudAccount: googleAccount("Ada Lovelace") });
    const updated = await run(signedIn.update({ displayName: "阿达" }));
    expect(updated.profile).toMatchObject({
      displayName: "阿达",
      avatar: { kind: "initials" },
    });
    expect(realm.row).toMatchObject({
      display_name: "阿达",
      avatar_kind: "initials",
      avatar_ref: null,
    });
  });
});
