// FILE: mcp.ts
// Purpose: Server half of the `mcp` capability: a page calls tools on the
// viewer's connected servers (Moss 应用, Settings connectors, local MCP
// servers). Every call passes, in order: the page's declared allowlist, the
// managed policy, the viewer's answer for that server, the rate limit, and —
// for destructive tools — the viewer's confirmation. Read-only results are
// cached per page and viewer. Every outcome is written to the audit log.
// Layer: Server pages/apps

import {
  PAGE_APP_MCP_CACHE_GC_MS,
  PAGE_APP_MCP_CALL_TIMEOUT_MS,
  PAGE_APP_MCP_DEFAULT_STALE_MS,
  PAGE_APP_MCP_MAX_ARGS_BYTES,
  PAGE_APP_MCP_MAX_RESULT_BYTES,
  PAGE_APP_MCP_MIN_WATCH_INTERVAL_MS,
  type PageAppMcpCallResult,
  type PageAppMcpConfig,
  type PageAppMcpListResult,
  type PageAppMcpServerDeclaration,
  type PageAppMcpServerInfo,
  type PageAppMcpServerState,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect, Stream } from "effect";

import {
  classifyMcpTool,
  evaluateManagedPolicy,
  findDeclaredServer,
  parsePageAppMcpConfig,
  SlidingWindowLimiter,
  type PageAppMcpManagedPolicy,
  type PageAppMcpToolClass,
} from "../extensions/mcpPolicy";
import type {
  PageAppMcpResolvedServer,
  PageAppMcpSources,
  PageAppMcpTool,
} from "../extensions/mcpSources";
import type { PageAppExtensionStore, PageAppGrantState } from "../extensions/PageAppExtensionStore";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

export interface PageAppMcpCapabilityDeps {
  readonly store: PageAppExtensionStore;
  readonly sources: PageAppMcpSources;
  readonly policy: () => Promise<PageAppMcpManagedPolicy>;
  readonly now: () => string;
  readonly clock?: () => number;
}

const CALLS_PER_MINUTE = 60;
const DESTRUCTIVE_PER_MINUTE = 10;
const TOOLS_CACHE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);
/** Runs a check that throws PageAppCapabilityError as a typed failure. */
const guard = <A>(check: () => A) =>
  Effect.try({
    try: check,
    catch: (error) =>
      error instanceof PageAppCapabilityError ? error : fail("unavailable", "The check failed."),
  });

/** Order-insensitive JSON for cache identity. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

interface CacheEntry {
  readonly result: PageAppMcpCallResult;
  readonly storedAt: number;
  readonly appId: string;
  readonly viewerId: string;
  readonly serverKey: string;
  readonly tool: string;
  readonly args: string;
}

export function makeMcpCapability(deps: PageAppMcpCapabilityDeps): PageAppServerCapability {
  const clock = deps.clock ?? Date.now;
  const limiter = new SlidingWindowLimiter(60_000, clock);
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<PageAppMcpCallResult>>();
  const toolLists = new Map<string, { at: number; tools: ReadonlyArray<PageAppMcpTool> }>();

  const gc = () => {
    const at = clock();
    for (const [key, entry] of cache)
      if (at - entry.storedAt > PAGE_APP_MCP_CACHE_GC_MS) cache.delete(key);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const configOf = (ctx: PageAppServerCallContext): PageAppMcpConfig => {
    const parsed = parsePageAppMcpConfig(ctx.config);
    if ("problem" in parsed) throw fail("invalid_argument", parsed.problem);
    return parsed.config;
  };

  const requireOwner = (ctx: PageAppServerCallContext) => {
    // Connectors carry the owner's sign-ins; nobody else may spend them.
    if (!ctx.viewer.isOwner)
      throw fail("unavailable", "只有这个 Moss 的主人能在应用页里使用连接的工具。");
  };

  const grantState = (grants: ReadonlyMap<string, PageAppGrantState>, key: string, tool = "") =>
    grants.get(`${key}\u0000${tool}`);

  const toolsOf = async (server: PageAppMcpResolvedServer, signal: AbortSignal) => {
    const cached = toolLists.get(server.key);
    if (cached && clock() - cached.at < TOOLS_CACHE_MS) return cached.tools;
    const tools = await server.session!.listTools(signal);
    toolLists.set(server.key, { at: clock(), tools });
    return tools;
  };

  const classify = async (
    server: PageAppMcpResolvedServer,
    tool: string,
    signal: AbortSignal,
  ): Promise<{
    readonly info: PageAppMcpTool | null;
    readonly cls: PageAppMcpToolClass;
    readonly available: boolean | null;
  }> => {
    try {
      const tools = await toolsOf(server, signal);
      const info = tools.find((candidate) => candidate.name === tool) ?? null;
      return { info, cls: classifyMcpTool(tool, info), available: info !== null };
    } catch {
      // Without the tool list Moss cannot tell; it asks before running.
      return { info: null, cls: classifyMcpTool(tool, null), available: null };
    }
  };

  const audit = (
    ctx: PageAppServerCallContext,
    method: string,
    target: string,
    outcome: string,
    detail?: string | null,
    startedAt?: number,
  ) =>
    deps.store
      .audit(
        {
          appId: ctx.app.id,
          revision: ctx.revision,
          viewerId: ctx.viewer.id,
          capability: "mcp",
          method,
          target,
          outcome,
          detail: detail ?? null,
          durationMs: startedAt === undefined ? null : clock() - startedAt,
        },
        deps.now(),
      )
      .pipe(Effect.catch(() => Effect.void));

  const runPromise = <A>(work: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => work(signal),
      catch: (cause) => {
        const error = toPageAppCallError(cause);
        return new PageAppCapabilityError(error.code, error.message);
      },
    });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  const serverInfo = async (
    declaration: PageAppMcpServerDeclaration,
    grants: ReadonlyMap<string, PageAppGrantState>,
    policy: PageAppMcpManagedPolicy,
    signal: AbortSignal,
  ): Promise<PageAppMcpServerInfo> => {
    const server = await deps.sources.resolve(declaration.server);
    const blocked = evaluateManagedPolicy(
      policy,
      { name: server.server, label: server.label },
      "*",
    );
    const answer = grantState(grants, server.key);
    let state: PageAppMcpServerState =
      answer === "granted" ? "granted" : answer === "denied" ? "denied" : "prompt";
    let reason = server.reason;
    if (!server.session) state = "unavailable";
    if (blocked.kind === "block") {
      state = "unavailable";
      reason = blocked.reason;
    }
    const live = state === "granted" && server.session;
    const tools = await Promise.all(
      declaration.tools.map(async (tool) => {
        const known = live
          ? await classify(server, tool, signal)
          : { info: null, cls: classifyMcpTool(tool, null), available: null };
        return {
          name: tool,
          title: known.info?.title ?? null,
          description: known.info?.description ?? null,
          readOnly: known.cls.readOnly,
          destructive: known.cls.destructive,
          available: known.available,
        };
      }),
    );
    return {
      server: declaration.server,
      label: server.label,
      kind: server.kind,
      state,
      reason,
      tools,
    };
  };

  const list = (ctx: PageAppServerCallContext) =>
    Effect.gen(function* () {
      yield* guard(() => requireOwner(ctx));
      const config = yield* guard(() => configOf(ctx));
      const grants = yield* deps.store.grants(ctx.app.id, ctx.viewer.id);
      return yield* runPromise(async (signal): Promise<PageAppMcpListResult> => {
        const policy = await deps.policy();
        return {
          servers: await Promise.all(
            config.servers.map((declaration) => serverInfo(declaration, grants, policy, signal)),
          ),
        };
      });
    });

  // -------------------------------------------------------------------------
  // grant (shell only: the frame plugin never relays it)
  // -------------------------------------------------------------------------

  const grant = (ctx: PageAppServerCallContext, args: unknown) =>
    Effect.gen(function* () {
      yield* guard(() => requireOwner(ctx));
      const config = yield* guard(() => configOf(ctx));
      if (!isRecord(args) || typeof args.server !== "string")
        return yield* Effect.fail(fail("invalid_argument", "grant needs a server."));
      const declaration = findDeclaredServer(config, args.server);
      if (!declaration)
        return yield* Effect.fail(
          fail("not_declared", `This page did not declare "${args.server}".`),
        );
      const state = args.state === "granted" || args.state === "denied" ? args.state : null;
      const server = yield* runPromise(() => deps.sources.resolve(declaration.server));
      yield* deps.store.setGrant({
        appId: ctx.app.id,
        viewerId: ctx.viewer.id,
        server: server.key,
        tool: "",
        state,
        now: deps.now(),
      });
      if (state !== "granted") {
        // Forgetting or refusing a server also forgets its remembered tools.
        const grants = yield* deps.store.grants(ctx.app.id, ctx.viewer.id);
        for (const key of grants.keys()) {
          const [serverKey, tool] = key.split("\u0000");
          if (serverKey === server.key && tool)
            yield* deps.store.setGrant({
              appId: ctx.app.id,
              viewerId: ctx.viewer.id,
              server: server.key,
              tool,
              state: null,
              now: deps.now(),
            });
        }
      }
      yield* audit(ctx, "grant", declaration.server, state ?? "forget");
      return { server: declaration.server, state: state ?? "prompt" };
    });

  // -------------------------------------------------------------------------
  // call
  // -------------------------------------------------------------------------

  interface Prepared {
    readonly declaration: PageAppMcpServerDeclaration;
    readonly server: PageAppMcpResolvedServer;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly cls: PageAppMcpToolClass;
    readonly info: PageAppMcpTool | null;
    readonly policyConfirm: boolean;
    readonly grants: ReadonlyMap<string, PageAppGrantState>;
    readonly cacheKey: string;
  }

  const prepare = (ctx: PageAppServerCallContext, raw: unknown, method: string) =>
    Effect.gen(function* () {
      yield* guard(() => requireOwner(ctx));
      const config = yield* guard(() => configOf(ctx));
      if (!isRecord(raw) || typeof raw.server !== "string" || typeof raw.tool !== "string")
        return yield* Effect.fail(fail("invalid_argument", `${method} needs server and tool.`));
      const target = `${raw.server}/${raw.tool}`;
      const declaration = findDeclaredServer(config, raw.server);
      if (!declaration || !declaration.tools.includes(raw.tool)) {
        yield* audit(ctx, method, target, "not_declared");
        return yield* Effect.fail(fail("not_declared", `This page did not declare ${target}.`));
      }
      const args = raw.args === undefined || raw.args === null ? {} : raw.args;
      if (!isRecord(args))
        return yield* Effect.fail(fail("invalid_argument", "Tool arguments must be an object."));
      const encoded = JSON.stringify(args);
      if (encoded.length > PAGE_APP_MCP_MAX_ARGS_BYTES)
        return yield* Effect.fail(fail("too_large", "Tool arguments are too large."));
      const server = yield* runPromise(() => deps.sources.resolve(declaration.server));
      if (!server.session) {
        const code = server.needsAuth ? "authentication_required" : "unavailable";
        yield* audit(ctx, method, target, code);
        return yield* Effect.fail(fail(code, server.reason ?? "This server is not available."));
      }
      const policy = yield* runPromise(() => deps.policy());
      const verdict = evaluateManagedPolicy(
        policy,
        { name: server.server, label: server.label },
        raw.tool,
      );
      if (verdict.kind === "block") {
        yield* audit(ctx, method, target, "policy_blocked");
        return yield* Effect.fail(fail("policy_blocked", verdict.reason));
      }
      const grants = yield* deps.store.grants(ctx.app.id, ctx.viewer.id);
      const answer = grantState(grants, server.key);
      if (answer === "denied") {
        yield* audit(ctx, method, target, "not_granted");
        return yield* Effect.fail(
          fail("not_granted", `The viewer did not allow ${server.label} on this page.`),
        );
      }
      if (answer !== "granted")
        return yield* Effect.fail(
          fail("consent_required", `Allow ${server.label} on this page first.`),
        );
      const limit = policy.maxCallsPerMinute ?? CALLS_PER_MINUTE;
      if (!limiter.admit(`${ctx.app.id}|${ctx.viewer.id}`, limit)) {
        yield* audit(ctx, method, target, "resource_exhausted");
        return yield* Effect.fail(
          fail("resource_exhausted", "Too many connector calls from this page; slow down."),
        );
      }
      const known = yield* runPromise((signal) => classify(server, raw.tool as string, signal));
      const prepared: Prepared = {
        declaration,
        server,
        tool: raw.tool,
        args,
        cls: known.cls,
        info: known.info,
        policyConfirm: verdict.confirm,
        grants,
        cacheKey: `${ctx.app.id}|${ctx.viewer.id}|${server.key}|${raw.tool}|${stableJson(args)}`,
      };
      return prepared;
    });

  const execute = (ctx: PageAppServerCallContext, prepared: Prepared, method: string) => {
    const target = `${prepared.declaration.server}/${prepared.tool}`;
    const startedAt = clock();
    const work = async (signal: AbortSignal): Promise<PageAppMcpCallResult> => {
      const timeout = AbortSignal.timeout(PAGE_APP_MCP_CALL_TIMEOUT_MS);
      const raw = await prepared.server.session!.callTool(
        prepared.tool,
        prepared.args,
        AbortSignal.any([signal, timeout]),
      );
      if (JSON.stringify(raw).length > PAGE_APP_MCP_MAX_RESULT_BYTES)
        throw fail("too_large", "The tool answered with more data than a page may receive.");
      return {
        content: raw.content,
        structuredContent: raw.structuredContent,
        isError: raw.isError,
      };
    };
    return runPromise((signal) => {
      // Identical read-only calls share one upstream request.
      if (!prepared.cls.readOnly) return work(signal);
      const existing = inflight.get(prepared.cacheKey);
      if (existing) return existing;
      const promise = work(signal).finally(() => inflight.delete(prepared.cacheKey));
      inflight.set(prepared.cacheKey, promise);
      return promise;
    }).pipe(
      Effect.tap((result) =>
        Effect.gen(function* () {
          if (prepared.cls.readOnly && !result.isError) {
            cache.set(prepared.cacheKey, {
              result,
              storedAt: clock(),
              appId: ctx.app.id,
              viewerId: ctx.viewer.id,
              serverKey: prepared.server.key,
              tool: prepared.tool,
              args: stableJson(prepared.args),
            });
            gc();
          }
          yield* audit(ctx, method, target, result.isError ? "tool_error" : "ok", null, startedAt);
        }),
      ),
      Effect.tapError((error) => audit(ctx, method, target, error.code, error.message, startedAt)),
    );
  };

  const call = (ctx: PageAppServerCallContext, raw: unknown) =>
    Effect.gen(function* () {
      const prepared = yield* prepare(ctx, raw, "call");
      const options = isRecord(raw) ? raw : {};
      const target = `${prepared.declaration.server}/${prepared.tool}`;
      const needsConfirm = prepared.cls.destructive || prepared.policyConfirm;
      if (needsConfirm) {
        if (!limiter.admit(`${ctx.app.id}|${ctx.viewer.id}|destructive`, DESTRUCTIVE_PER_MINUTE)) {
          yield* audit(ctx, "call", target, "resource_exhausted");
          return yield* Effect.fail(
            fail("resource_exhausted", "Too many changes from this page; slow down."),
          );
        }
        const remembered =
          !prepared.policyConfirm &&
          grantState(prepared.grants, prepared.server.key, prepared.tool) === "granted";
        const approval = options.approval;
        if (!remembered && approval !== "once" && approval !== "remember")
          return yield* Effect.fail(
            fail(
              "confirmation_required",
              `${prepared.server.label} 的「${prepared.info?.title ?? prepared.tool}」需要你确认。`,
            ),
          );
        if (approval === "remember" && !prepared.policyConfirm)
          yield* deps.store.setGrant({
            appId: ctx.app.id,
            viewerId: ctx.viewer.id,
            server: prepared.server.key,
            tool: prepared.tool,
            state: "granted",
            now: deps.now(),
          });
      }
      const cacheOption = options.cache;
      const useCache = prepared.cls.readOnly && cacheOption !== false;
      if (useCache) {
        const staleTime =
          isRecord(cacheOption) &&
          typeof cacheOption.staleTime === "number" &&
          cacheOption.staleTime >= 0
            ? Math.min(cacheOption.staleTime, PAGE_APP_MCP_CACHE_GC_MS)
            : PAGE_APP_MCP_DEFAULT_STALE_MS;
        const refresh = isRecord(cacheOption) && cacheOption.refresh === true;
        const entry = cache.get(prepared.cacheKey);
        if (entry && !refresh && clock() - entry.storedAt <= staleTime) {
          yield* audit(ctx, "call", target, "cached");
          return { ...entry.result, cache: { storedAt: entry.storedAt, revalidating: false } };
        }
      }
      return yield* execute(ctx, prepared, "call");
    });

  const describe = (ctx: PageAppServerCallContext, raw: unknown) =>
    Effect.gen(function* () {
      yield* guard(() => requireOwner(ctx));
      const config = yield* guard(() => configOf(ctx));
      if (!isRecord(raw) || typeof raw.server !== "string")
        return yield* Effect.fail(fail("invalid_argument", "describe needs a server."));
      const declaration = findDeclaredServer(config, raw.server);
      if (!declaration)
        return yield* Effect.fail(
          fail("not_declared", `This page did not declare "${raw.server}".`),
        );
      const grants = yield* deps.store.grants(ctx.app.id, ctx.viewer.id);
      return yield* runPromise(async (signal) => {
        const info = await serverInfo(declaration, grants, await deps.policy(), signal);
        const tool =
          typeof raw.tool === "string"
            ? (info.tools.find((entry) => entry.name === raw.tool) ?? null)
            : null;
        return { server: info, tool };
      });
    });

  const invalidate = (ctx: PageAppServerCallContext, raw: unknown) =>
    Effect.gen(function* () {
      const options = isRecord(raw) ? raw : {};
      const serverKey =
        typeof options.server === "string"
          ? (yield* runPromise(() => deps.sources.resolve(options.server as string))).key
          : null;
      const args = options.args === undefined ? null : stableJson(options.args);
      let dropped = 0;
      for (const [key, entry] of cache) {
        if (entry.appId !== ctx.app.id || entry.viewerId !== ctx.viewer.id) continue;
        if (serverKey !== null && entry.serverKey !== serverKey) continue;
        if (typeof options.tool === "string" && entry.tool !== options.tool) continue;
        if (args !== null && entry.args !== args) continue;
        cache.delete(key);
        dropped += 1;
      }
      return { dropped };
    });

  // -------------------------------------------------------------------------
  // watch (display arm: cached first, then fresh, then on an interval)
  // -------------------------------------------------------------------------

  const watch = (
    ctx: PageAppServerCallContext,
    raw: unknown,
  ): Stream.Stream<unknown, PageAppCapabilityError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const prepared = yield* prepare(ctx, raw, "watch");
        if (!prepared.cls.readOnly || prepared.cls.destructive || prepared.policyConfirm)
          return yield* Effect.fail(
            fail(
              "invalid_argument",
              "Only read-only tools can be watched; use callTool for actions.",
            ),
          );
        const options = isRecord(raw) ? raw : {};
        const staleTime =
          typeof options.staleTime === "number" && options.staleTime >= 0
            ? Math.min(options.staleTime, PAGE_APP_MCP_CACHE_GC_MS)
            : PAGE_APP_MCP_DEFAULT_STALE_MS;
        const interval =
          typeof options.intervalMs === "number" && options.intervalMs > 0
            ? Math.max(options.intervalMs, PAGE_APP_MCP_MIN_WATCH_INTERVAL_MS)
            : null;
        const fresh = execute(ctx, prepared, "watch").pipe(
          Effect.map((result) => ({ result })),
          Effect.catch((error) => Effect.succeed({ error: error.toJSON() })),
        );
        const entry = cache.get(prepared.cacheKey);
        const age = entry ? clock() - entry.storedAt : Infinity;
        const replay =
          entry !== undefined
            ? Stream.succeed({
                result: {
                  ...entry.result,
                  cache: { storedAt: entry.storedAt, revalidating: age > staleTime },
                },
              })
            : Stream.empty;
        const first = age > staleTime ? Stream.fromEffect(fresh) : Stream.empty;
        const repeat =
          interval === null
            ? Stream.never
            : Stream.fromEffect(Effect.sleep(interval).pipe(Effect.andThen(fresh))).pipe(
                Stream.forever,
              );
        return replay.pipe(Stream.concat(first), Stream.concat(repeat));
      }),
    );

  return {
    name: "mcp",
    // Consent is per server, kept by this capability (see `grant`).
    consent: "none",
    validateConfig: (config) => {
      const parsed = parsePageAppMcpConfig(config);
      return "problem" in parsed ? parsed.problem : null;
    },
    call: (ctx, method, args) => {
      const wrap = <A>(effect: Effect.Effect<A, PageAppCapabilityError>) =>
        Effect.suspend(() => effect).pipe(
          Effect.catchDefect((defect) =>
            Effect.fail(
              defect instanceof PageAppCapabilityError
                ? defect
                : fail("unavailable", "The connector call failed unexpectedly."),
            ),
          ),
        );
      switch (method) {
        case "list":
          return wrap(list(ctx));
        case "describe":
          return wrap(describe(ctx, args));
        case "grant":
          return wrap(grant(ctx, args));
        case "call":
          return wrap(call(ctx, args));
        case "invalidate":
          return wrap(invalidate(ctx, args));
        default:
          return Effect.fail(fail("invalid_argument", `mcp has no "${method}".`));
      }
    },
    watch: (ctx, method, args) => {
      if (method !== "watch")
        return Stream.fail(fail("invalid_argument", `mcp has no "${method}".`));
      return watch(ctx, args);
    },
  };
}
