// FILE: comments.ts
// Purpose: Server half of the `comments` capability: the 应用页's own comment
// store (migration PageAppCapabilities). Comments point at an element inside the page; the
// shell writes them from Moss's composer, pages list and watch them to draw
// their own markers. Viewers may resolve any comment and remove their own;
// the owner may remove any.
// Layer: Server pages/apps

import { randomUUID } from "node:crypto";

import {
  PAGE_APP_COMMENT_MAX_CHARS,
  PAGE_APP_COMMENTS_MAX_COUNT,
  type PageAppComment,
  type PageAppCommentAnchor,
  type PageAppViewer,
} from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect, Queue, Stream } from "effect";

import type { PageAppCommentRow, PageAppExtensionStore } from "../extensions/PageAppExtensionStore";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

const unit = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;

export function parseCommentAnchor(raw: unknown): PageAppCommentAnchor {
  if (
    !isRecord(raw) ||
    typeof raw.target !== "string" ||
    !raw.target.trim() ||
    raw.target.length > 1_000
  )
    throw fail("invalid_argument", "A comment needs an anchor with a target.");
  return {
    target: raw.target,
    label:
      typeof raw.label === "string" ? raw.label.replace(/\s+/gu, " ").trim().slice(0, 120) : "",
    x: unit(raw.x),
    y: unit(raw.y),
    quote:
      typeof raw.quote === "string" && raw.quote.trim() ? raw.quote.trim().slice(0, 500) : null,
  };
}

export const commentShape = (row: PageAppCommentRow, viewer: PageAppViewer): PageAppComment => ({
  id: row.id,
  anchor: row.anchor,
  body: row.body,
  author: { id: row.authorId, name: row.authorName },
  mine: row.authorId === viewer.id,
  resolvedAt: row.resolvedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface PageAppCommentsDeps {
  readonly store: PageAppExtensionStore;
  readonly now: () => string;
}

export function makeCommentsCapability(deps: PageAppCommentsDeps): PageAppServerCapability {
  // Live listeners per page; a write tells each to re-read.
  const listeners = new Map<string, Set<() => void>>();
  const changed = (appId: string) => {
    for (const listener of listeners.get(appId) ?? []) listener();
  };

  const list = (ctx: PageAppServerCallContext) =>
    deps.store
      .listComments(ctx.app.id)
      .pipe(Effect.map((rows) => rows.map((row) => commentShape(row, ctx.viewer))));

  const owned = (ctx: PageAppServerCallContext, id: unknown) =>
    Effect.gen(function* () {
      if (typeof id !== "string")
        return yield* Effect.fail(fail("invalid_argument", "Name the comment by id."));
      const row = yield* deps.store.getComment(ctx.app.id, id);
      if (!row) return yield* Effect.fail(fail("not_found", "No such comment."));
      return row;
    });

  const call = (ctx: PageAppServerCallContext, method: string, raw: unknown) =>
    Effect.gen(function* () {
      const args = isRecord(raw) ? raw : {};
      switch (method) {
        case "list":
          return { comments: yield* list(ctx) };
        case "add": {
          if (ctx.viewer.level === "view" && !ctx.viewer.isOwner)
            return yield* Effect.fail(
              fail("not_granted", "Your access to this page cannot comment."),
            );
          const anchor = yield* Effect.try({
            try: () => parseCommentAnchor(args.anchor),
            catch: (error) =>
              error instanceof PageAppCapabilityError
                ? error
                : fail("invalid_argument", "Bad anchor."),
          });
          const body = typeof args.body === "string" ? args.body.trim() : "";
          if (!body)
            return yield* Effect.fail(fail("invalid_argument", "A comment cannot be empty."));
          if (body.length > PAGE_APP_COMMENT_MAX_CHARS)
            return yield* Effect.fail(
              fail("too_large", `A comment is at most ${PAGE_APP_COMMENT_MAX_CHARS} characters.`),
            );
          if ((yield* deps.store.countComments(ctx.app.id)) >= PAGE_APP_COMMENTS_MAX_COUNT)
            return yield* Effect.fail(fail("quota_exceeded", "This page has too many comments."));
          const now = deps.now();
          const row: PageAppCommentRow = {
            id: randomUUID(),
            appId: ctx.app.id,
            anchor,
            body,
            authorId: ctx.viewer.id,
            authorName: ctx.viewer.name,
            resolvedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* deps.store.insertComment(row);
          changed(ctx.app.id);
          return { comment: commentShape(row, ctx.viewer) };
        }
        case "resolve": {
          const row = yield* owned(ctx, args.id);
          const now = deps.now();
          yield* deps.store.updateComment(ctx.app.id, row.id, {
            resolvedAt: args.resolved === false ? null : now,
            now,
          });
          changed(ctx.app.id);
          return { ok: true };
        }
        case "edit": {
          const row = yield* owned(ctx, args.id);
          if (row.authorId !== ctx.viewer.id)
            return yield* Effect.fail(fail("not_granted", "Only the author can edit a comment."));
          const body = typeof args.body === "string" ? args.body.trim() : "";
          if (!body || body.length > PAGE_APP_COMMENT_MAX_CHARS)
            return yield* Effect.fail(fail("invalid_argument", "A comment is 1-4000 characters."));
          yield* deps.store.updateComment(ctx.app.id, row.id, { body, now: deps.now() });
          changed(ctx.app.id);
          return { ok: true };
        }
        case "delete": {
          const row = yield* owned(ctx, args.id);
          if (row.authorId !== ctx.viewer.id && !ctx.viewer.isOwner)
            return yield* Effect.fail(
              fail("not_granted", "Only the author or the owner can remove a comment."),
            );
          yield* deps.store.deleteComment(ctx.app.id, row.id);
          changed(ctx.app.id);
          return { ok: true };
        }
        default:
          return yield* Effect.fail(fail("invalid_argument", `comments has no "${method}".`));
      }
    });

  const watch = (ctx: PageAppServerCallContext): Stream.Stream<unknown, PageAppCapabilityError> =>
    Stream.callback<unknown, PageAppCapabilityError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let running = false;
          let again = false;
          const refresh = () => {
            if (running) {
              again = true;
              return;
            }
            running = true;
            void Effect.runPromise(Effect.result(list(ctx))).then((result) => {
              running = false;
              if (result._tag === "Success") Queue.offerUnsafe(queue, { comments: result.success });
              if (again) {
                again = false;
                refresh();
              }
            });
          };
          let set = listeners.get(ctx.app.id);
          if (!set) {
            set = new Set();
            listeners.set(ctx.app.id, set);
          }
          set.add(refresh);
          refresh();
          return refresh;
        }),
        (refresh) =>
          Effect.sync(() => {
            const set = listeners.get(ctx.app.id);
            set?.delete(refresh);
            if (set?.size === 0) listeners.delete(ctx.app.id);
          }),
      ),
    );

  return {
    name: "comments",
    consent: "none",
    validateConfig: (config) =>
      config === undefined || config === null || isRecord(config)
        ? null
        : "comments config must be an object.",
    call,
    watch: (ctx, method) =>
      method === "watch"
        ? watch(ctx)
        : Stream.fail(fail("invalid_argument", `comments has no "${method}".`)),
  };
}
