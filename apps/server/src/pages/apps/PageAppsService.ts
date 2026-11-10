// FILE: PageAppsService.ts
// Purpose: 应用页 (runnable HTML pages): storage, versions (newest 100 kept),
// metadata, favorite/rename/trash, per-page consent, frame tokens, and the
// server side of capability calls. Capability plugins do the actual work.
// Layer: Server pages/apps

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  PAGE_APP_FRAME_TOKEN_TTL_MS,
  PAGE_APP_MAX_VERSIONS,
  PageApp,
  PageAppCapabilities,
  PageAppId,
  PageAppVersion,
  PageAppsCallInput,
  PageAppsConsentInput,
  PageAppsListInput,
  PageAppsMutateInput,
  PageAppsMutateResult,
  PageAppsReadInput,
  PageAppsVersionsInput,
  type PageAppFrameMode,
  type PageAppStoredConsent,
  type PageAppViewer,
  type PageAppsCallResult,
  type PageAppsConsentResult,
  type PageAppsListResult,
  type PageAppsReadResult,
  type PageAppsVersionsResult,
  type PageAppsWatchInput,
  type SpaceId,
  type ThreadId,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { readPageAppManifest, writePageAppManifest } from "@moss/shared/pageAppManifest";
import { Effect, Layer, Schema, ServiceMap, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { stableGatewayDigest } from "../../agentGateway/creationUtils";
import type { PagesPrincipal } from "../Services/PagesService";
import type { PageAppAiGateway } from "./aiGateway";
import { makePageAppServerCapabilities } from "./capabilities";
import type { PageAppExtensionDeps } from "./extensions";
import type { PageAppServerCapability, PageAppServerCallContext } from "./capabilities/types";
import { makePageAppDbStore, type PageAppDbStore } from "./PageAppDbStore";
import { validPageAppThumbnail } from "./thumbnail";

export class PageAppsServiceError extends Schema.TaggedErrorClass<PageAppsServiceError>()(
  "PageAppsServiceError",
  {
    code: Schema.String,
    message: Schema.String,
    currentRevision: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** The local Moss user owns every 应用页 in this profile. */
export const LOCAL_OWNER_VIEWER: PageAppViewer = {
  id: "owner",
  name: "我",
  level: "owner",
  isOwner: true,
};

export interface PageAppFrameTokenPayload {
  readonly appId: string;
  readonly revision: number;
  readonly parentOrigin: string;
  readonly mode: PageAppFrameMode;
  readonly expiresAt: number;
}

export interface PageAppFrameContent {
  readonly app: PageApp;
  readonly revision: number;
  readonly html: string;
  readonly capabilities: PageAppCapabilities;
}

export interface PageAppsServiceShape {
  readonly list: (
    input: PageAppsListInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageAppsListResult, PageAppsServiceError>;
  readonly read: (
    input: PageAppsReadInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageAppsReadResult, PageAppsServiceError>;
  readonly versions: (
    input: PageAppsVersionsInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageAppsVersionsResult, PageAppsServiceError>;
  readonly mutate: (
    input: PageAppsMutateInput,
    principal: PagesPrincipal,
  ) => Effect.Effect<PageAppsMutateResult, PageAppsServiceError>;
  readonly consent: (
    input: PageAppsConsentInput,
    viewer: PageAppViewer,
  ) => Effect.Effect<PageAppsConsentResult, PageAppsServiceError>;
  readonly call: (
    input: PageAppsCallInput,
    principal: PagesPrincipal,
    viewer: PageAppViewer,
  ) => Effect.Effect<PageAppsCallResult, PageAppsServiceError>;
  readonly watch: (
    input: PageAppsWatchInput,
    principal: PagesPrincipal,
    viewer: PageAppViewer,
  ) => Stream.Stream<{ readonly value: unknown }, PageAppsServiceError>;
  readonly mintFrameToken: (payload: PageAppFrameTokenPayload) => string;
  readonly verifyFrameToken: (token: string, now?: number) => PageAppFrameTokenPayload | null;
  readonly frameContent: (
    appId: PageAppId,
    revision: number,
  ) => Effect.Effect<PageAppFrameContent, PageAppsServiceError>;
  /** The db store, for agent tools that read and write a page's data as its owner. */
  readonly db: PageAppDbStore;
  /** Names of capabilities the server serves (declared names outside this set are inert). */
  readonly servedCapabilities: ReadonlyArray<string>;
}

export class PageAppsService extends ServiceMap.Service<PageAppsService, PageAppsServiceShape>()(
  "moss/pages/apps/PageAppsService",
) {}

type Scope = SpaceId | null;
type AppRow = {
  app_id: string;
  scope_key: string;
  space_id: string | null;
  title: string;
  description: string;
  revision: number;
  capabilities_json: string;
  favorite: number;
  thumbnail: string | null;
  source_thread_id: string | null;
  html_chars: number;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
};
type VersionRow = {
  app_id: string;
  revision: number;
  title: string;
  description: string;
  capabilities_json: string;
  html: string;
  operation: string;
  author: string;
  author_thread_id: string | null;
  created_at: string;
};

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TITLE = "未命名应用页";
/** Built in: every page may read and ask for its own permissions. */
const IMPLICIT_CAPABILITIES = new Set(["permissions"]);

const scopeKey = (scope: Scope) => (scope === null ? "local-default" : `project-space:${scope}`);
const scopeFromKey = (key: string): Scope =>
  key === "local-default" ? null : (key.slice("project-space:".length) as SpaceId);
const failure = (code: string, message: string, currentRevision?: number) =>
  new PageAppsServiceError({
    code,
    message,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new PageAppsServiceError({
        code: "invalid_argument",
        message: "Invalid 应用页 input",
        cause,
      }),
  });

const appFromRow = (row: AppRow): PageApp =>
  Schema.decodeUnknownSync(PageApp)({
    id: row.app_id,
    scopeSpaceId: scopeFromKey(row.scope_key),
    spaceId: row.space_id,
    title: row.title,
    description: row.description,
    revision: row.revision,
    capabilities: JSON.parse(row.capabilities_json),
    favorite: row.favorite !== 0,
    thumbnail: row.thumbnail,
    sourceThreadId: row.source_thread_id,
    htmlChars: row.html_chars,
    trashedAt: row.trashed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
const versionFromRow = (row: VersionRow): PageAppVersion =>
  Schema.decodeUnknownSync(PageAppVersion)({
    appId: row.app_id,
    revision: row.revision,
    title: row.title,
    description: row.description,
    capabilities: JSON.parse(row.capabilities_json),
    htmlChars: row.html.length,
    operation: row.operation,
    author: row.author,
    authorThreadId: row.author_thread_id,
    createdAt: row.created_at,
  });

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export interface PageAppsServiceDeps {
  readonly ai: PageAppAiGateway;
  readonly now?: () => string;
  readonly id?: () => string;
  readonly tokenSecret?: Buffer;
  readonly extensions?: PageAppExtensionDeps | null;
}

export const makePageAppsServiceShape = (deps: PageAppsServiceDeps) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = deps.now ?? (() => new Date().toISOString());
    const newId = deps.id ?? randomUUID;
    const secret = deps.tokenSecret ?? randomBytes(32);
    const db = yield* makePageAppDbStore();
    const capabilities: ReadonlyArray<PageAppServerCapability> = makePageAppServerCapabilities({
      db,
      ai: deps.ai,
      extensions: deps.extensions ?? null,
      now,
      // A page republishing itself acts as the local owner, like an edit in Moss.
      republish: (ctx, html) =>
        mutate(
          {
            op: "update",
            requestId: newId(),
            appId: ctx.app.id,
            expectedRevision: ctx.app.revision,
            html,
          },
          { kind: "local-user" },
        ).pipe(
          Effect.map((result) => result.app),
          Effect.mapError((error) => new PageAppCapabilityError(error.code, error.message)),
        ),
    });
    const capabilityByName = new Map(
      capabilities.map((capability) => [capability.name, capability]),
    );

    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof PageAppsServiceError
            ? cause
            : new PageAppsServiceError({
                code: "storage",
                message: "应用页 storage operation failed",
                cause,
              }),
        ),
      );

    const threadScope = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ space_id: Scope }>`SELECT p.space_id
          FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL
            AND t.archived_at IS NULL`;
        if (!rows[0])
          return yield* Effect.fail(failure("not_found", "The caller has no active local project"));
        return rows[0].space_id;
      });
    const authorize = (scope: Scope, principal: PagesPrincipal) =>
      Effect.gen(function* () {
        if (principal.kind === "agent" && (yield* threadScope(principal.threadId)) !== scope) {
          return yield* Effect.fail(
            failure("not_found", "应用页 belongs to another authorization space"),
          );
        }
      });
    const appRow = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<AppRow>`SELECT * FROM page_apps WHERE app_id = ${id}`;
        if (!rows[0]) return yield* Effect.fail(failure("not_found", "应用页 not found"));
        return rows[0];
      });
    const authorizedApp = (id: string, principal: PagesPrincipal) =>
      Effect.gen(function* () {
        const row = yield* appRow(id);
        yield* authorize(scopeFromKey(row.scope_key), principal);
        return appFromRow(row);
      });
    const versionRow = (id: string, revision: number) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<VersionRow>`SELECT * FROM page_app_versions WHERE app_id = ${id} AND revision = ${revision}`;
        if (!rows[0]) return yield* Effect.fail(failure("not_found", "应用页 version not found"));
        return rows[0];
      });

    const validateCapabilities = (declared: PageAppCapabilities) =>
      Effect.gen(function* () {
        for (const [name, config] of Object.entries(declared)) {
          const capability = capabilityByName.get(name);
          if (!capability && !IMPLICIT_CAPABILITIES.has(name) && !SHELL_ONLY.has(name)) {
            return yield* Effect.fail(
              failure(
                "invalid_argument",
                `Unknown capability "${name}". Served: ${servedCapabilities.join(", ")}.`,
              ),
            );
          }
          const problem = capability?.validateConfig?.(config) ?? null;
          if (problem) return yield* Effect.fail(failure("invalid_argument", problem));
        }
      });

    /** Resolve title/description/capabilities and keep the HTML manifest in sync. */
    const prepareHtml = (
      html: string,
      explicit: {
        readonly title?: string | undefined;
        readonly description?: string | undefined;
        readonly capabilities?: PageAppCapabilities | undefined;
      },
      fallback?: {
        readonly title: string;
        readonly description: string;
        readonly capabilities: PageAppCapabilities;
      },
    ) =>
      Effect.gen(function* () {
        const manifest = readPageAppManifest(html);
        const title = (explicit.title ?? manifest.title ?? fallback?.title ?? DEFAULT_TITLE)
          .trim()
          .slice(0, 256);
        const description = (
          explicit.description ??
          manifest.description ??
          fallback?.description ??
          ""
        ).slice(0, 2_000);
        const declared = yield* decode(
          PageAppCapabilities,
          explicit.capabilities ?? manifest.capabilities ?? fallback?.capabilities ?? {},
        );
        yield* validateCapabilities(declared);
        const finalHtml = writePageAppManifest(html, {
          title: title || DEFAULT_TITLE,
          description,
          capabilities: declared,
        });
        if (finalHtml.length > 2_000_000)
          return yield* Effect.fail(
            failure("invalid_argument", "应用页 HTML is over 2,000,000 characters"),
          );
        return {
          html: finalHtml,
          title: title || DEFAULT_TITLE,
          description,
          capabilities: declared,
        };
      });

    const save = (
      app: PageApp,
      version: { readonly html: string; readonly operation: string } | null,
      principal: PagesPrincipal,
      previousRevision: number | null,
    ) =>
      Effect.gen(function* () {
        const key = scopeKey(app.scopeSpaceId);
        if (previousRevision === null) {
          yield* sql`INSERT INTO page_apps (app_id, scope_key, space_id, title, description, revision,
            capabilities_json, favorite, thumbnail, source_thread_id, html_chars, trashed_at, created_at, updated_at)
            VALUES (${app.id}, ${key}, ${app.spaceId}, ${app.title}, ${app.description}, ${app.revision},
            ${JSON.stringify(app.capabilities)}, ${app.favorite ? 1 : 0}, ${app.thumbnail}, ${app.sourceThreadId},
            ${app.htmlChars}, ${app.trashedAt}, ${app.createdAt}, ${app.updatedAt})`;
        } else {
          const changed =
            yield* sql`UPDATE page_apps SET space_id = ${app.spaceId}, title = ${app.title},
            description = ${app.description}, revision = ${app.revision},
            capabilities_json = ${JSON.stringify(app.capabilities)}, favorite = ${app.favorite ? 1 : 0},
            thumbnail = ${app.thumbnail}, html_chars = ${app.htmlChars}, trashed_at = ${app.trashedAt},
            updated_at = ${app.updatedAt}
            WHERE app_id = ${app.id} AND revision = ${previousRevision} RETURNING app_id`;
          if (changed.length !== 1)
            return yield* Effect.fail(failure("conflict", "应用页 changed during this edit"));
        }
        if (version) {
          yield* sql`INSERT INTO page_app_versions (app_id, revision, title, description, capabilities_json,
            html, operation, author, author_thread_id, created_at)
            VALUES (${app.id}, ${app.revision}, ${app.title}, ${app.description},
            ${JSON.stringify(app.capabilities)}, ${version.html}, ${version.operation}, ${principal.kind},
            ${principal.kind === "agent" ? principal.threadId : null}, ${app.updatedAt})`;
          yield* sql`DELETE FROM page_app_versions
            WHERE app_id = ${app.id} AND revision <= ${app.revision - PAGE_APP_MAX_VERSIONS}`;
        }
      });

    const currentHtml = (app: PageApp) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ html: string }>`SELECT html FROM page_app_versions
          WHERE app_id = ${app.id} ORDER BY revision DESC LIMIT 1`;
        return rows[0]?.html ?? "";
      });

    const purgeExpiredTrash = Effect.gen(function* () {
      const cutoff = new Date(Date.parse(now()) - TRASH_RETENTION_MS).toISOString();
      const expired = yield* sql<{ app_id: string }>`SELECT app_id FROM page_apps
        WHERE trashed_at IS NOT NULL AND trashed_at < ${cutoff}`;
      for (const { app_id } of expired) {
        yield* sql`DELETE FROM page_app_documents WHERE app_id = ${app_id}`;
        yield* sql`DELETE FROM page_app_consents WHERE app_id = ${app_id}`;
        yield* sql`DELETE FROM page_app_versions WHERE app_id = ${app_id}`;
        yield* sql`DELETE FROM page_apps WHERE app_id = ${app_id}`;
      }
    });

    const list: PageAppsServiceShape["list"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsListInput, raw);
          yield* authorize(input.scopeSpaceId, principal);
          yield* sql.withTransaction(purgeExpiredTrash);
          const rows = input.includeTrashed
            ? yield* sql<AppRow>`SELECT * FROM page_apps WHERE scope_key = ${scopeKey(input.scopeSpaceId)}
                ORDER BY updated_at DESC`
            : yield* sql<AppRow>`SELECT * FROM page_apps WHERE scope_key = ${scopeKey(input.scopeSpaceId)}
                AND trashed_at IS NULL ORDER BY updated_at DESC`;
          return { apps: rows.map(appFromRow) };
        }),
      );

    const read: PageAppsServiceShape["read"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsReadInput, raw);
          const app = yield* authorizedApp(input.appId, principal);
          const version = yield* versionRow(app.id, input.revision ?? app.revision);
          return {
            app,
            revision: version.revision,
            html: version.html,
            capabilities: JSON.parse(version.capabilities_json),
          };
        }),
      );

    const versions: PageAppsServiceShape["versions"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsVersionsInput, raw);
          const app = yield* authorizedApp(input.appId, principal);
          const before = input.beforeRevision ?? app.revision + 1;
          const limit = input.limit ?? 50;
          const rows = yield* sql<VersionRow>`SELECT * FROM page_app_versions
            WHERE app_id = ${app.id} AND revision < ${before} ORDER BY revision DESC LIMIT ${limit}`;
          return { versions: rows.map(versionFromRow) };
        }),
      );

    const mutate: PageAppsServiceShape["mutate"] = (raw, principal) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsMutateInput, raw);
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const scope: Scope =
                input.op === "create"
                  ? input.scopeSpaceId
                  : scopeFromKey((yield* appRow(input.appId)).scope_key);
              yield* authorize(scope, principal);
              const key = scopeKey(scope);
              const actorKey =
                principal.kind === "local-user" ? "local-user" : `thread:${principal.threadId}`;
              const fingerprint = stableGatewayDigest(input, 64);
              const prior = yield* sql<{ fingerprint: string; result_json: string }>`
                SELECT fingerprint, result_json FROM page_app_requests
                WHERE scope_key = ${key} AND actor_key = ${actorKey} AND request_id = ${input.requestId}`;
              if (prior[0]) {
                if (prior[0].fingerprint !== fingerprint)
                  return yield* Effect.fail(
                    failure("conflict", "This request id was used for a different 应用页 change"),
                  );
                return yield* decode(PageAppsMutateResult, JSON.parse(prior[0].result_json));
              }
              const timestamp = now();
              let app: PageApp;
              if (input.op === "create") {
                if (input.sourceThreadId && principal.kind === "agent") {
                  if ((yield* threadScope(input.sourceThreadId)) !== scope)
                    return yield* Effect.fail(
                      failure("not_found", "Source conversation belongs to another space"),
                    );
                }
                const prepared = yield* prepareHtml(input.html, input);
                app = {
                  id: PageAppId.makeUnsafe(newId()),
                  scopeSpaceId: scope,
                  spaceId: input.spaceId ?? null,
                  title: prepared.title,
                  description: prepared.description,
                  revision: 1,
                  capabilities: prepared.capabilities,
                  favorite: false,
                  thumbnail: null,
                  sourceThreadId:
                    input.sourceThreadId ??
                    (principal.kind === "agent" ? principal.threadId : null),
                  htmlChars: prepared.html.length,
                  trashedAt: null,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                };
                yield* save(app, { html: prepared.html, operation: "create" }, principal, null);
              } else {
                const current = appFromRow(yield* appRow(input.appId));
                if (current.revision !== input.expectedRevision)
                  return yield* Effect.fail(
                    failure("conflict", "应用页 changed since it was read", current.revision),
                  );
                if (current.trashedAt !== null && input.op !== "restore")
                  return yield* Effect.fail(
                    failure("invalid_argument", "Restore this 应用页 before changing it"),
                  );
                const next = { ...current, revision: current.revision + 1, updatedAt: timestamp };
                let version: { html: string; operation: string } | null = null;
                switch (input.op) {
                  case "update": {
                    const sourceHtml = input.html ?? (yield* currentHtml(current));
                    const prepared = yield* prepareHtml(
                      sourceHtml,
                      {
                        title: input.title,
                        description: input.description,
                        capabilities:
                          input.capabilities ??
                          (input.html === undefined ? current.capabilities : undefined),
                      },
                      // New HTML without a manifest keeps what the page already declared.
                      current,
                    );
                    app = {
                      ...next,
                      title: prepared.title,
                      description: prepared.description,
                      capabilities: prepared.capabilities,
                      htmlChars: prepared.html.length,
                      thumbnail: null,
                    };
                    version = { html: prepared.html, operation: "update" };
                    break;
                  }
                  case "rename": {
                    const prepared = yield* prepareHtml(yield* currentHtml(current), {
                      title: input.title,
                      description: current.description,
                      capabilities: current.capabilities,
                    });
                    app = {
                      ...next,
                      title: prepared.title,
                      htmlChars: prepared.html.length,
                      thumbnail: null,
                    };
                    version = { html: prepared.html, operation: "rename" };
                    break;
                  }
                  case "restore-version": {
                    const old = yield* versionRow(current.id, input.revision);
                    app = {
                      ...next,
                      title: old.title,
                      description: old.description,
                      capabilities: JSON.parse(old.capabilities_json),
                      htmlChars: old.html.length,
                      thumbnail: null,
                    };
                    version = { html: old.html, operation: `restore-version:${input.revision}` };
                    break;
                  }
                  case "favorite":
                    app = { ...next, favorite: input.favorite };
                    break;
                  case "set-thumbnail":
                    if (input.thumbnail !== null && !validPageAppThumbnail(input.thumbnail))
                      return yield* Effect.fail(
                        failure("invalid_argument", "Thumbnail must be a bounded JPEG image."),
                      );
                    // A derived preview must not invalidate the running frame or create a version.
                    // save() still atomically checks expectedRevision against the current row.
                    app = { ...current, thumbnail: input.thumbnail };
                    break;
                  case "move":
                    app = { ...next, spaceId: input.spaceId };
                    break;
                  case "trash":
                    app = { ...next, trashedAt: timestamp };
                    break;
                  case "restore":
                    app = { ...next, trashedAt: null };
                    break;
                }
                yield* save(app, version, principal, current.revision);
              }
              const result = { app };
              yield* sql`INSERT INTO page_app_requests (scope_key, actor_key, request_id, fingerprint, result_json, created_at)
                VALUES (${key}, ${actorKey}, ${input.requestId}, ${fingerprint}, ${JSON.stringify(result)}, ${timestamp})`;
              return result;
            }),
          );
        }),
      );

    const storedConsent = (appId: string, viewerId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ capability: string; state: PageAppStoredConsent }>`
          SELECT capability, state FROM page_app_consents WHERE app_id = ${appId} AND viewer_id = ${viewerId}`;
        return Object.fromEntries(rows.map((row) => [row.capability, row.state])) as Record<
          string,
          PageAppStoredConsent
        >;
      });

    const consent: PageAppsServiceShape["consent"] = (raw, viewer) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsConsentInput, raw);
          yield* appRow(input.appId);
          if (input.op === "set") {
            if (input.state === null) {
              yield* sql`DELETE FROM page_app_consents WHERE app_id = ${input.appId}
                AND viewer_id = ${viewer.id} AND capability = ${input.capability}`;
            } else {
              yield* sql`INSERT INTO page_app_consents (app_id, viewer_id, capability, state, updated_at)
                VALUES (${input.appId}, ${viewer.id}, ${input.capability}, ${input.state}, ${now()})
                ON CONFLICT (app_id, viewer_id, capability) DO UPDATE SET state = excluded.state,
                updated_at = excluded.updated_at`;
            }
          }
          return { consent: yield* storedConsent(input.appId, viewer.id) };
        }),
      );

    const callContext = (
      input: PageAppsCallInput,
      principal: PagesPrincipal,
      viewer: PageAppViewer,
    ) =>
      Effect.gen(function* () {
        const app = yield* authorizedApp(input.appId, principal);
        if (app.trashedAt !== null)
          return yield* Effect.fail(failure("revoked", "This 应用页 is in the trash"));
        const version = yield* versionRow(app.id, input.revision);
        const declared: PageAppCapabilities = JSON.parse(version.capabilities_json);
        const capability = capabilityByName.get(input.capability);
        if (!capability)
          return yield* Effect.fail(
            failure("unavailable", `Capability "${input.capability}" is not served here`),
          );
        if (!(input.capability in declared) && !IMPLICIT_CAPABILITIES.has(input.capability))
          return yield* Effect.fail(
            failure("not_declared", `This page did not declare "${input.capability}"`),
          );
        const consentMap = yield* storedConsent(app.id, viewer.id);
        // Agent tools act for the owner through their own tool approval.
        if (
          principal.kind === "local-user" &&
          capability.consent === "standing" &&
          consentMap[input.capability] !== "granted"
        ) {
          return yield* Effect.fail(
            failure("not_granted", `The viewer has not allowed "${input.capability}" on this page`),
          );
        }
        const ctx: PageAppServerCallContext = {
          app,
          revision: version.revision,
          capabilities: declared,
          config: declared[input.capability] ?? {},
          viewer,
          consent: consentMap,
        };
        return { capability, ctx };
      });

    const fromCapabilityError = (error: unknown) => {
      const call = toPageAppCallError(error);
      return failure(call.code, call.message);
    };

    const call: PageAppsServiceShape["call"] = (raw, principal, viewer) =>
      protect(
        Effect.gen(function* () {
          const input = yield* decode(PageAppsCallInput, raw);
          const { capability, ctx } = yield* callContext(input, principal, viewer);
          if (!capability.call)
            return yield* Effect.fail(failure("invalid_argument", "This capability has no calls"));
          const value = yield* capability
            .call(ctx, input.method, input.args)
            .pipe(Effect.mapError(fromCapabilityError));
          return { value };
        }),
      );

    const watch: PageAppsServiceShape["watch"] = (raw, principal, viewer) =>
      Stream.unwrap(
        protect(
          Effect.gen(function* () {
            const input = yield* decode(PageAppsCallInput, raw);
            const { capability, ctx } = yield* callContext(input, principal, viewer);
            if (!capability.watch)
              return yield* Effect.fail(
                failure("invalid_argument", "This capability has no subscriptions"),
              );
            return capability.watch(ctx, input.method, input.args).pipe(
              Stream.map((value) => ({ value })),
              Stream.mapError(fromCapabilityError),
            );
          }),
        ),
      );

    const sign = (body: string) => createHmac("sha256", secret).update(body).digest();
    const mintFrameToken: PageAppsServiceShape["mintFrameToken"] = (payload) => {
      const body = base64url(
        JSON.stringify({
          a: payload.appId,
          r: payload.revision,
          o: payload.parentOrigin,
          m: payload.mode,
          e: payload.expiresAt,
        }),
      );
      return `${body}.${base64url(sign(body))}`;
    };
    const verifyFrameToken: PageAppsServiceShape["verifyFrameToken"] = (token, at = Date.now()) => {
      const [body, mac, extra] = token.split(".");
      if (!body || !mac || extra !== undefined || token.length > 4_096) return null;
      const expected = sign(body);
      const given = Buffer.from(mac, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (
          typeof parsed.a !== "string" ||
          !Number.isSafeInteger(parsed.r) ||
          typeof parsed.o !== "string" ||
          !["full", "embed", "guest"].includes(parsed.m) ||
          typeof parsed.e !== "number" ||
          parsed.e < at
        )
          return null;
        return {
          appId: parsed.a,
          revision: parsed.r,
          parentOrigin: parsed.o,
          mode: parsed.m,
          expiresAt: parsed.e,
        };
      } catch {
        return null;
      }
    };

    const frameContent: PageAppsServiceShape["frameContent"] = (appId, revision) =>
      protect(
        Effect.gen(function* () {
          const app = appFromRow(yield* appRow(appId));
          if (app.trashedAt !== null)
            return yield* Effect.fail(failure("revoked", "This 应用页 is in the trash"));
          const version = yield* versionRow(appId, revision);
          return {
            app,
            revision: version.revision,
            html: version.html,
            capabilities: JSON.parse(version.capabilities_json),
          };
        }),
      );

    const servedCapabilities = [
      ...new Set([
        ...capabilities.map((capability) => capability.name),
        ...IMPLICIT_CAPABILITIES,
        ...SHELL_ONLY,
      ]),
    ];

    return {
      list,
      read,
      versions,
      mutate,
      consent,
      call,
      watch,
      mintFrameToken,
      verifyFrameToken,
      frameContent,
      db,
      servedCapabilities,
    } satisfies PageAppsServiceShape;
  });

/** Capabilities answered entirely by the shell (no server half). */
const SHELL_ONLY = new Set(["downloads", "user"]);

export const PAGE_APP_FRAME_TOKEN_TTL = PAGE_APP_FRAME_TOKEN_TTL_MS;

export const makePageAppsServiceLayer = (deps: PageAppsServiceDeps) =>
  Layer.effect(PageAppsService, makePageAppsServiceShape(deps));
