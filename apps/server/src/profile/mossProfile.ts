// FILE: mossProfile.ts
// Purpose: The person's Moss profile (display name, @handle, avatar) behind the
// `profile.*` RPCs. A signed-in account's profile lives in its realm's database
// (`public.moss_profiles`, uploads in the `moss-avatars` bucket), read and written
// with the account's own session; the last copy is cached on this computer so the
// profile still shows offline. A signed-out Moss keeps one local profile instead.
// Layer: server (account-adjacent service, no cloud credentials leave this file).

import * as nodePath from "node:path";
import * as fs from "node:fs/promises";

import {
  MOSS_PROFILE_AVATAR_MAX_BYTES,
  MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH,
  MOSS_PROFILE_ERROR_CODES,
  MOSS_PROFILE_HANDLE_MAX_LENGTH,
  MOSS_PROFILE_HANDLE_MIN_LENGTH,
  MOSS_PROFILE_RESERVED_HANDLES,
  MossProfile,
  MossProfileDisplayName,
  type MossAccountRealm,
  type MossProfileAvatarMimeType,
  type MossProfileCheckHandleInput,
  type MossProfileCheckHandleResult,
  type MossProfileHandleStatus,
  type MossProfileState,
  type MossProfileUpdateInput,
  type MossProfileUploadAvatarInput,
  WsRpcError,
} from "@moss/contracts";
import { Effect, Schema, Semaphore } from "effect";

import {
  configuredAuthorityRest,
  type MossPayAuthorityCredential,
} from "../account/Layers/MossPayService";
import type { MossCloudAccountServiceShape } from "../account/Services/MossCloudAccountService";
import type { MossPhoneAccountServiceShape } from "../account/Services/MossPhoneAccountService";
import { writeFileStringAtomically } from "../atomicWrite";

export interface MossProfileServiceShape {
  readonly get: () => Effect.Effect<MossProfileState, WsRpcError>;
  readonly update: (input: MossProfileUpdateInput) => Effect.Effect<MossProfileState, WsRpcError>;
  readonly checkHandle: (
    input: MossProfileCheckHandleInput,
  ) => Effect.Effect<MossProfileCheckHandleResult, WsRpcError>;
  readonly uploadAvatar: (
    input: MossProfileUploadAvatarInput,
  ) => Effect.Effect<MossProfileState, WsRpcError>;
}

export interface MossProfileServiceOptions {
  readonly phoneAccount: Pick<
    MossPhoneAccountServiceShape,
    "getLocalAuthority" | "getAuthorityCredential"
  >;
  readonly cloudAccount: Pick<
    MossCloudAccountServiceShape,
    "getLocalAuthority" | "getAuthorityCredential"
  >;
  readonly stateDir: string;
  readonly homeDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

export const MOSS_PROFILE_STORE_FILE = "moss-profile.json";
const AVATAR_BUCKET = "moss-avatars";
const REQUEST_TIMEOUT_MS = 8_000;
const AVATAR_UPLOAD_TIMEOUT_MS = 30_000;

// ── Pure rules ───────────────────────────────────────────────────────

const RESERVED = new Set(MOSS_PROFILE_RESERVED_HANDLES);

/** Format verdict for a normalized handle, or null when it is well-formed. */
export function handleFormatStatus(handle: string): MossProfileHandleStatus | null {
  if (!/^[a-z0-9_]*$/u.test(handle)) return "invalid_characters";
  if (handle.length < MOSS_PROFILE_HANDLE_MIN_LENGTH) return "too_short";
  if (handle.length > MOSS_PROFILE_HANDLE_MAX_LENGTH) return "too_long";
  if (RESERVED.has(handle)) return "reserved";
  return null;
}

export function normalizeHandleInput(value: string): string {
  return value.trim().replace(/^@+/u, "").toLowerCase();
}

/** A valid display name from an account name or the home folder, else "Moss". */
export function defaultDisplayName(...candidates: ReadonlyArray<string | null | undefined>) {
  const isValid = Schema.is(MossProfileDisplayName);
  for (const candidate of candidates) {
    const visible = [...(candidate ?? "")]
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f ? " " : char;
      })
      .join("")
      .trim();
    const cleaned = [...visible].slice(0, MOSS_PROFILE_DISPLAY_NAME_MAX_LENGTH).join("").trim();
    if (cleaned && isValid(cleaned)) return cleaned;
  }
  return "Moss";
}

const AVATAR_SIGNATURES: Record<MossProfileAvatarMimeType, (bytes: Uint8Array) => boolean> = {
  "image/png": (b) =>
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => b[index] === value),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) =>
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
};

/** The picture's bytes when they are a real PNG/JPEG/WebP of at most 1 MB, else null. */
export function decodeAvatarUpload(input: MossProfileUploadAvatarInput): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.dataBase64) || input.dataBase64.length % 4 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
  if (bytes.byteLength < 12 || bytes.byteLength > MOSS_PROFILE_AVATAR_MAX_BYTES) return null;
  return AVATAR_SIGNATURES[input.mimeType](bytes) ? bytes : null;
}

// ── Remote rows ──────────────────────────────────────────────────────

interface ProfileRow {
  readonly display_name: string;
  readonly handle: string | null;
  readonly avatar_kind: "initials" | "preset" | "upload";
  readonly avatar_ref: string | null;
  readonly updated_at: string | null;
}

const RemoteRow = Schema.Struct({
  display_name: Schema.String,
  handle: Schema.NullOr(Schema.String),
  avatar_kind: Schema.Literals(["initials", "preset", "upload"]),
  avatar_ref: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.String),
});

export function profileFromRow(row: ProfileRow, baseUrl: string): MossProfile {
  const version = row.updated_at ? Date.parse(row.updated_at) : Number.NaN;
  const avatar: MossProfile["avatar"] =
    row.avatar_kind === "preset" && row.avatar_ref
      ? { kind: "preset", id: row.avatar_ref }
      : row.avatar_kind === "upload" && row.avatar_ref
        ? {
            kind: "upload",
            url: `${baseUrl}/storage/v1/object/public/${AVATAR_BUCKET}/${row.avatar_ref}${
              Number.isFinite(version) ? `?v=${version}` : ""
            }`,
          }
        : { kind: "initials" };
  return {
    displayName: row.display_name,
    handle: row.handle,
    avatar,
    updatedAt: row.updated_at,
  };
}

function jwtSubject(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const sub = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown }
    ).sub;
    return typeof sub === "string" && /^[0-9a-f-]{36}$/u.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

// ── Errors ───────────────────────────────────────────────────────────

const offlineError = () =>
  new WsRpcError({
    message: "暂时连不上 Moss 账号服务，请稍后再试。",
    code: MOSS_PROFILE_ERROR_CODES.offline,
    retryable: true,
  });
const handleTakenError = () =>
  new WsRpcError({
    message: "这个 ID 已被占用，换一个试试。",
    code: MOSS_PROFILE_ERROR_CODES.handleTaken,
    retryable: false,
  });
const invalidError = () =>
  new WsRpcError({
    message: "资料内容不符合要求。",
    code: MOSS_PROFILE_ERROR_CODES.invalid,
    retryable: false,
  });
const avatarInvalidError = () =>
  new WsRpcError({
    message: "头像需为 1 MB 以内的 PNG、JPEG 或 WebP 图片。",
    code: MOSS_PROFILE_ERROR_CODES.avatarInvalid,
    retryable: false,
  });

// Raised inside remote calls: the realm, network or session is unavailable.
class ProfileRemoteUnavailable extends Error {}

// ── Local store ──────────────────────────────────────────────────────

const ProfileStore = Schema.Struct({
  version: Schema.Literal(1),
  local: Schema.NullOr(MossProfile),
  accounts: Schema.Record(Schema.String, MossProfile),
});
type ProfileStore = typeof ProfileStore.Type;
const EMPTY_STORE: ProfileStore = { version: 1, local: null, accounts: {} };

interface ResolvedAccount {
  readonly realm: MossAccountRealm;
  readonly key: string;
  readonly defaultName: string;
  readonly credential: () => Effect.Effect<MossPayAuthorityCredential, unknown>;
}

interface Remote {
  readonly credential: MossPayAuthorityCredential;
  readonly baseUrl: string;
  readonly publishableKey: string;
}

const accountDefaults = (account: ResolvedAccount): MossProfile => ({
  displayName: account.defaultName,
  handle: null,
  avatar: { kind: "initials" },
  updatedAt: null,
});

const accountState = (
  account: ResolvedAccount,
  profile: MossProfile,
  synced: boolean,
): MossProfileState => ({
  scope: "account",
  realm: account.realm,
  sync: synced ? "synced" : "offline",
  editable: synced,
  profile,
});
const localState = (profile: MossProfile): MossProfileState => ({
  scope: "local",
  realm: null,
  sync: "local",
  editable: true,
  profile,
});

export function makeMossProfileService(options: MossProfileServiceOptions) {
  return Effect.gen(function* () {
    const storePath = nodePath.join(options.stateDir, MOSS_PROFILE_STORE_FILE);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const env = options.env ?? process.env;
    const homeName = nodePath.basename(options.homeDir);
    const storeLock = yield* Semaphore.make(1);

    const readStore = Effect.promise(async (): Promise<ProfileStore> => {
      try {
        return Schema.decodeUnknownSync(ProfileStore)(
          JSON.parse(await fs.readFile(storePath, "utf8")),
        );
      } catch {
        // Missing or unreadable: start over; the account copy is re-read from the realm.
        return EMPTY_STORE;
      }
    });
    const modifyStore = (change: (store: ProfileStore) => ProfileStore) =>
      storeLock.withPermits(1)(
        readStore.pipe(
          Effect.flatMap((store) =>
            writeFileStringAtomically({
              filePath: storePath,
              contents: `${JSON.stringify(change(store), null, 2)}\n`,
            }),
          ),
        ),
      );
    // A cache that cannot be written only costs the offline copy.
    const cacheAccount = (account: ResolvedAccount, profile: MossProfile) =>
      modifyStore((store) => ({
        ...store,
        accounts: { ...store.accounts, [account.key]: profile },
      })).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Moss profile cache write failed", { error: String(cause) }),
        ),
      );

    const localDefaults = (): MossProfile => {
      const handle = normalizeHandleInput(homeName).replace(/[^a-z0-9_]/gu, "");
      return {
        displayName: defaultDisplayName(homeName),
        handle: handleFormatStatus(handle) === null ? handle : null,
        avatar: { kind: "initials" },
        updatedAt: null,
      };
    };
    // Local account state only (no network): a phone account first, as payments do.
    const resolveAccount = Effect.gen(function* () {
      const phone = yield* options.phoneAccount
        .getLocalAuthority()
        .pipe(Effect.catch(() => Effect.succeed({ identity: null })));
      if (phone.identity) {
        return {
          realm: "cn",
          key: `cn:${phone.identity.account.id}`,
          defaultName: defaultDisplayName(phone.identity.displayName, homeName),
          credential: () => options.phoneAccount.getAuthorityCredential(),
        } satisfies ResolvedAccount;
      }
      const cloud = yield* options.cloudAccount
        .getLocalAuthority()
        .pipe(Effect.catch(() => Effect.succeed({ identity: null })));
      if (cloud.identity) {
        return {
          realm: "global",
          key: `global:${cloud.identity.account.id}`,
          defaultName: defaultDisplayName(cloud.identity.displayName, homeName),
          credential: () => options.cloudAccount.getAuthorityCredential(),
        } satisfies ResolvedAccount;
      }
      return null;
    });

    const connect = (account: ResolvedAccount) =>
      account.credential().pipe(
        Effect.flatMap((credential) =>
          Effect.try({
            try: (): Remote => ({ credential, ...configuredAuthorityRest({ credential, env }) }),
            catch: () => new ProfileRemoteUnavailable(),
          }),
        ),
        Effect.mapError(() => new ProfileRemoteUnavailable()),
      );

    const request = (
      remote: Remote,
      path: string,
      init: { method: string; body?: string | Uint8Array; headers?: Record<string, string> },
      timeoutMs = REQUEST_TIMEOUT_MS,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(new URL(path, remote.baseUrl), {
            method: init.method,
            headers: {
              accept: "application/json",
              apikey: remote.publishableKey,
              authorization: `Bearer ${remote.credential.accessToken}`,
              ...init.headers,
            },
            ...(init.body === undefined ? {} : { body: init.body }),
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          if (response.status === 401 || response.status === 403 || response.status >= 500) {
            throw new ProfileRemoteUnavailable();
          }
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          return { status: response.status, body };
        },
        catch: (cause) =>
          cause instanceof ProfileRemoteUnavailable ? cause : new ProfileRemoteUnavailable(),
      });

    const rpc = (remote: Remote, name: string, args: Record<string, unknown>) =>
      request(remote, `/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });

    const readRow = (remote: Remote) =>
      request(
        remote,
        "/rest/v1/moss_profiles?select=display_name,handle,avatar_kind,avatar_ref,updated_at&limit=1",
        { method: "GET" },
      ).pipe(
        Effect.flatMap(({ status, body }) => {
          if (status !== 200 || !Array.isArray(body)) {
            return Effect.fail(new ProfileRemoteUnavailable());
          }
          if (body.length === 0) return Effect.succeed(null);
          return Effect.try({
            try: () => Schema.decodeUnknownSync(RemoteRow)(body[0]),
            catch: () => new ProfileRemoteUnavailable(),
          });
        }),
      );

    const saveRow = (remote: Remote, row: Omit<ProfileRow, "updated_at">) =>
      rpc(remote, "moss_save_my_profile", {
        p_display_name: row.display_name,
        p_handle: row.handle,
        p_avatar_kind: row.avatar_kind,
        p_avatar_ref: row.avatar_ref,
      }).pipe(
        Effect.mapError(() => offlineError()),
        Effect.flatMap(({ status, body }) => {
          const code = (body as { code?: unknown } | null)?.code;
          if (status === 409 || code === "23505") return Effect.fail(handleTakenError());
          if (status >= 200 && status < 300) {
            return Effect.try({
              try: () => Schema.decodeUnknownSync(RemoteRow)(body),
              catch: () => offlineError(),
            });
          }
          return Effect.fail(invalidError());
        }),
      );

    const logOutcome = (operation: string, scope: string, outcome: string) =>
      Effect.logInfo("Moss profile request", { operation, scope, outcome });

    const offlineAccountState = (account: ResolvedAccount) =>
      readStore.pipe(
        Effect.map((store) =>
          accountState(account, store.accounts[account.key] ?? accountDefaults(account), false),
        ),
      );

    const get: MossProfileServiceShape["get"] = () =>
      Effect.gen(function* () {
        const account = yield* resolveAccount;
        if (!account) {
          const store = yield* readStore;
          yield* logOutcome("get", "local", "local");
          return localState(store.local ?? localDefaults());
        }
        const fetched = yield* connect(account).pipe(
          Effect.flatMap((remote) =>
            readRow(remote).pipe(
              Effect.map((row) =>
                row ? profileFromRow(row, remote.baseUrl) : accountDefaults(account),
              ),
            ),
          ),
          Effect.option,
        );
        if (fetched._tag === "None") {
          yield* logOutcome("get", account.realm, "offline");
          return yield* offlineAccountState(account);
        }
        if (fetched.value.updatedAt !== null) yield* cacheAccount(account, fetched.value);
        yield* logOutcome("get", account.realm, "synced");
        return accountState(account, fetched.value, true);
      });

    // Read the current row, apply `change`, save the whole row.
    const saveAccount = (
      account: ResolvedAccount,
      operation: string,
      change: (
        row: Omit<ProfileRow, "updated_at">,
        remote: Remote,
      ) => Effect.Effect<Omit<ProfileRow, "updated_at">, WsRpcError>,
    ) =>
      Effect.gen(function* () {
        const remote = yield* connect(account).pipe(Effect.mapError(() => offlineError()));
        const current = yield* readRow(remote).pipe(Effect.mapError(() => offlineError()));
        const base = current ?? {
          display_name: account.defaultName,
          handle: null,
          avatar_kind: "initials" as const,
          avatar_ref: null,
        };
        const saved = yield* saveRow(remote, yield* change(base, remote));
        const profile = profileFromRow(saved, remote.baseUrl);
        yield* cacheAccount(account, profile);
        yield* logOutcome(operation, account.realm, "saved");
        return accountState(account, profile, true);
      }).pipe(
        Effect.tapError((error) => logOutcome(operation, account.realm, error.code ?? "failed")),
      );

    const saveLocal = (change: (profile: MossProfile) => MossProfile, operation: string) =>
      storeLock
        .withPermits(1)(
          Effect.gen(function* () {
            const store = yield* readStore;
            const next = {
              ...change(store.local ?? localDefaults()),
              updatedAt: new Date().toISOString(),
            };
            yield* writeFileStringAtomically({
              filePath: storePath,
              contents: `${JSON.stringify({ ...store, local: next }, null, 2)}\n`,
            });
            return next;
          }),
        )
        .pipe(
          Effect.mapError(
            () =>
              new WsRpcError({
                message: "无法在本机保存资料。",
                code: MOSS_PROFILE_ERROR_CODES.invalid,
                retryable: true,
              }),
          ),
          Effect.tap(() => logOutcome(operation, "local", "saved")),
          Effect.map(localState),
        );

    const update: MossProfileServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const account = yield* resolveAccount;
        if (!account) {
          return yield* saveLocal(
            (profile) => ({
              ...profile,
              ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
              ...(input.handle === undefined ? {} : { handle: input.handle }),
              ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
            }),
            "update",
          );
        }
        return yield* saveAccount(account, "update", (row) =>
          Effect.succeed({
            display_name: input.displayName ?? row.display_name,
            handle: input.handle ?? row.handle,
            avatar_kind: input.avatar?.kind ?? row.avatar_kind,
            avatar_ref:
              input.avatar === undefined
                ? row.avatar_ref
                : input.avatar.kind === "preset"
                  ? input.avatar.id
                  : null,
          }),
        );
      });

    const checkHandle: MossProfileServiceShape["checkHandle"] = (input) =>
      Effect.gen(function* () {
        const handle = normalizeHandleInput(input.handle);
        const invalid = handleFormatStatus(handle);
        if (invalid) return { handle, status: invalid };
        const account = yield* resolveAccount;
        const store = yield* readStore;
        const current = account ? store.accounts[account.key]?.handle : store.local?.handle;
        if (current === handle) return { handle, status: "current" as const };
        if (!account) return { handle, status: "available" as const };
        const answer = yield* connect(account).pipe(
          Effect.flatMap((remote) =>
            rpc(remote, "moss_check_handle_available", { p_handle: handle }),
          ),
          Effect.option,
        );
        if (answer._tag === "None" || answer.value.status !== 200) {
          return { handle, status: "unverified" as const };
        }
        return { handle, status: answer.value.body === true ? "available" : "taken" } as const;
      });

    const uploadAvatar: MossProfileServiceShape["uploadAvatar"] = (input) =>
      Effect.gen(function* () {
        const bytes = decodeAvatarUpload(input);
        if (!bytes) return yield* Effect.fail(avatarInvalidError());
        const account = yield* resolveAccount;
        if (!account) {
          const url = `data:${input.mimeType};base64,${input.dataBase64}`;
          return yield* saveLocal(
            (profile) => ({ ...profile, avatar: { kind: "upload", url } }),
            "uploadAvatar",
          );
        }
        return yield* saveAccount(account, "uploadAvatar", (row, remote) =>
          Effect.gen(function* () {
            const owner = jwtSubject(remote.credential.accessToken);
            if (!owner) return yield* Effect.fail(offlineError());
            const objectPath = `${owner}/avatar`;
            const stored = yield* request(
              remote,
              `/storage/v1/object/${AVATAR_BUCKET}/${objectPath}`,
              {
                method: "POST",
                headers: {
                  "content-type": input.mimeType,
                  "cache-control": "max-age=60",
                  "x-upsert": "true",
                },
                body: bytes,
              },
              AVATAR_UPLOAD_TIMEOUT_MS,
            ).pipe(Effect.mapError(() => offlineError()));
            const storageStatus = String(
              (stored.body as { statusCode?: unknown } | null)?.statusCode ?? stored.status,
            );
            if (storageStatus === "413" || storageStatus === "415" || stored.status === 413) {
              return yield* Effect.fail(avatarInvalidError());
            }
            if (stored.status < 200 || stored.status >= 300)
              return yield* Effect.fail(offlineError());
            return { ...row, avatar_kind: "upload" as const, avatar_ref: objectPath };
          }),
        );
      });

    return { get, update, checkHandle, uploadAvatar } satisfies MossProfileServiceShape;
  });
}
