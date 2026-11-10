// FILE: db.ts
// Purpose: Server half of the `db` capability: relays page calls to the
// document store with the page's declared rules and the viewer's level.
// Layer: Server pages/apps

import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { pageAppDbRulesFromConfig, validatePageAppDbRules } from "@moss/shared/pageAppDbRules";
import { Effect, Stream } from "effect";

import type { PageAppDbScope, PageAppDbStore } from "../PageAppDbStore";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const field = (args: unknown, name: string): unknown =>
  args && typeof args === "object" ? (args as Record<string, unknown>)[name] : undefined;

export const dbScope = (ctx: PageAppServerCallContext): PageAppDbScope => ({
  appId: ctx.app.id,
  rules: pageAppDbRulesFromConfig(ctx.config),
  viewer: ctx.viewer,
});

export function makeDbCapability(deps: {
  readonly db: PageAppDbStore;
  readonly now: () => string;
}): PageAppServerCapability {
  return {
    name: "db",
    consent: "standing",
    validateConfig: (config) => {
      if (config === undefined || config === null) return null;
      if (typeof config !== "object" || Array.isArray(config))
        return "db config must be an object.";
      const rules = (config as { rules?: unknown }).rules;
      if (rules === undefined) return null;
      if (!Array.isArray(rules)) return "db.rules must be a list.";
      const problems = validatePageAppDbRules(pageAppDbRulesFromConfig(config));
      return problems.length ? `db rules: ${problems.join(" ")}` : null;
    },
    call: (ctx, method, args) => {
      const scope = dbScope(ctx);
      switch (method) {
        case "get":
          return deps.db.get(scope, field(args, "path"));
        case "set":
          return deps.db.write(scope, field(args, "path"), field(args, "data"), "set", deps.now());
        case "update":
          return deps.db.write(
            scope,
            field(args, "path"),
            field(args, "data"),
            "update",
            deps.now(),
          );
        case "delete":
          return deps.db.remove(scope, field(args, "path"));
        case "query":
          return deps.db.query(scope, args);
        case "acquire":
          return deps.db.acquire(
            scope,
            field(args, "path"),
            field(args, "ttlMs"),
            field(args, "data"),
            deps.now(),
          );
        default:
          return Effect.fail(
            new PageAppCapabilityError("invalid_argument", `db has no "${method}".`),
          );
      }
    },
    watch: (ctx, method, args) => {
      const scope = dbScope(ctx);
      if (method === "watchDoc") return deps.db.watchDoc(scope, field(args, "path"));
      if (method === "watchQuery") return deps.db.watchQuery(scope, args);
      return Stream.fail(new PageAppCapabilityError("invalid_argument", `db has no "${method}".`));
    },
  };
}
