// FILE: page.ts
// Purpose: Server half of the `page` capability: metadata and republishing
// the page itself as a new version (owner/admin only).
// Layer: Server pages/apps

import type { PageApp } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";

import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

export type PageAppRepublish = (
  ctx: PageAppServerCallContext,
  html: string,
) => Effect.Effect<PageApp, PageAppCapabilityError>;

export function makePageCapability(deps: {
  readonly republish: PageAppRepublish;
}): PageAppServerCapability {
  return {
    name: "page",
    consent: "none",
    call: (ctx, method, args) => {
      if (method === "metadata") {
        return Effect.succeed({
          id: ctx.app.id,
          title: ctx.app.title,
          description: ctx.app.description,
          revision: ctx.revision,
          latestRevision: ctx.app.revision,
          updatedAt: ctx.app.updatedAt,
        });
      }
      if (method === "publish") {
        if (ctx.viewer.level !== "owner" && ctx.viewer.level !== "admin")
          return Effect.fail(
            new PageAppCapabilityError("invalid_argument", "Only editors may publish this page."),
          );
        const html =
          args && typeof args === "object" ? (args as { html?: unknown }).html : undefined;
        if (typeof html !== "string" || !html.trim())
          return Effect.fail(
            new PageAppCapabilityError("invalid_argument", "publish() needs HTML."),
          );
        return deps
          .republish(ctx, html)
          .pipe(Effect.map((app) => ({ revision: app.revision, updatedAt: app.updatedAt })));
      }
      return Effect.fail(
        new PageAppCapabilityError("invalid_argument", `page has no "${method}".`),
      );
    },
  };
}
