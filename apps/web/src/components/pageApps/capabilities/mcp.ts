// FILE: mcp.ts
// Purpose: Shell half of `mcp`: relays a page's connector calls to the
// server and answers the two questions only the viewer can: may this page use
// that server (asked once per server, remembered), and may it run this
// destructive tool now (asked every time unless the viewer ticks remember).
// The page never sees tokens, URLs or the approval flag; the shell sets it.
// Layer: Web pageApps capability

import type { PageAppMcpServerInfo, PageAppMcpToolInfo } from "@moss/contracts";
import {
  PageAppCapabilityError,
  toPageAppCallError,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const MAX_PROMPT_ROUNDS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One server question at a time per page, so parallel calls share one dialog. */
const serverQuestions = new Map<string, Promise<boolean>>();

async function describe(
  ctx: PageAppShellContext,
  server: string,
  tool?: string,
): Promise<{ server: PageAppMcpServerInfo; tool: PageAppMcpToolInfo | null }> {
  return (await ctx.serverCall("describe", tool ? { server, tool } : { server })) as {
    server: PageAppMcpServerInfo;
    tool: PageAppMcpToolInfo | null;
  };
}

export function askForServer(ctx: PageAppShellContext, server: string): Promise<boolean> {
  const key = `${ctx.appId}\u0000${server.toLowerCase()}`;
  const existing = serverQuestions.get(key);
  if (existing) return existing;
  const question = (async () => {
    const info = (await describe(ctx, server)).server;
    if (info.state === "granted") return true;
    if (info.state === "denied") return false;
    if (info.state === "unavailable")
      throw new PageAppCapabilityError("unavailable", info.reason ?? `${info.label} 现在不可用。`);
    const allowed = await ctx.confirm({
      title: `允许「${ctx.title}」使用 ${info.label}？`,
      body: "这个应用页会以你的身份调用下面这些工具。你的登录信息不会交给页面；会修改内容的操作每次都会先问你。",
      confirmLabel: "允许",
      details: [info.label, ...info.tools.map((tool) => tool.title ?? tool.name)],
    });
    await ctx.serverCall("grant", { server, state: allowed ? "granted" : "denied" });
    return allowed;
  })().finally(() => serverQuestions.delete(key));
  serverQuestions.set(key, question);
  return question;
}

async function confirmTool(ctx: PageAppShellContext, server: string, tool: string) {
  const info = await describe(ctx, server, tool);
  const toolInfo = info.tool;
  const name = toolInfo?.title ?? tool;
  return ctx.confirmChoice({
    title: `允许「${ctx.title}」执行「${name}」？`,
    body: `这个操作会通过 ${info.server.label} 修改或发送内容，可能无法撤销。`,
    confirmLabel: "执行",
    tone: "danger",
    details: [
      `${info.server.label} · ${tool}`,
      ...(toolInfo?.description ? [toolInfo.description.slice(0, 200)] : []),
    ],
    rememberLabel: "对这个应用页记住，以后不再询问",
  });
}

async function callTool(ctx: PageAppShellContext, raw: unknown): Promise<unknown> {
  if (!isRecord(raw) || typeof raw.server !== "string" || typeof raw.tool !== "string")
    throw new PageAppCapabilityError(
      "invalid_argument",
      "callTool(server, tool, args) needs a server and a tool.",
    );
  // Only the shell decides approval; whatever the page sent is dropped.
  const request: Readonly<Record<string, unknown>> = {
    server: raw.server,
    tool: raw.tool,
    args: raw.args ?? {},
    ...(raw.cache === false || isRecord(raw.cache) ? { cache: raw.cache } : {}),
  };
  let approval: "once" | "remember" | null = null;
  for (let round = 0; ; round += 1) {
    try {
      return await ctx.serverCall("call", approval ? { ...request, approval } : request);
    } catch (error) {
      const { code } = toPageAppCallError(error);
      if (round >= MAX_PROMPT_ROUNDS) throw error;
      if (code === "consent_required") {
        if (!(await askForServer(ctx, raw.server)))
          throw new PageAppCapabilityError(
            "not_granted",
            "The viewer did not allow this server on this page.",
          );
        continue;
      }
      if (code === "confirmation_required") {
        const answer = await confirmTool(ctx, raw.server, raw.tool);
        if (!answer.confirmed)
          throw new PageAppCapabilityError("declined", "The viewer declined this action.");
        approval = answer.remember ? "remember" : "once";
        continue;
      }
      throw error;
    }
  }
}

export const mcpShellPlugin: PageAppShellPlugin = {
  name: "mcp",
  // Consent is per server, asked by this plugin and kept by the server half.
  consent: "none",
  // Connectors carry the owner's sign-ins; shared views never get them.
  modes: ["full", "embed"],
  label: "连接的应用和工具",
  purpose: "让这个应用页用你在 Moss 里连接的应用和工具读取或处理内容，每个应用都会单独问你。",
  rateLimit: { burst: 20, perMinute: 60 },
  call: (ctx, method, args) => {
    switch (method) {
      case "list":
        return ctx.serverCall("list", null);
      case "call":
        return callTool(ctx, args);
      case "invalidate":
        return ctx.serverCall("invalidate", isRecord(args) ? args : {});
      case "request": {
        const server = isRecord(args) && typeof args.server === "string" ? args.server : null;
        if (!server)
          throw new PageAppCapabilityError("invalid_argument", "request(server) needs a server.");
        return askForServer(ctx, server).then((granted) => ({ granted }));
      }
      default:
        throw new PageAppCapabilityError("invalid_argument", `mcp has no "${method}".`);
    }
  },
  watch: (ctx, method, args, sink) => {
    if (method !== "watch" || !isRecord(args) || typeof args.server !== "string") {
      sink.end({
        code: "invalid_argument",
        message: "watchTool(server, tool, args) needs a server and a tool.",
      });
      return () => undefined;
    }
    const server = args.server;
    let cancel: (() => void) | null = null;
    let stopped = false;
    void askForServer(ctx, server).then(
      (granted) => {
        if (stopped) return;
        if (!granted) {
          sink.end({
            code: "not_granted",
            message: "The viewer did not allow this server on this page.",
          });
          return;
        }
        const { approval: _approval, ...clean } = args;
        cancel = ctx.serverWatch("watch", clean, sink);
      },
      (error: unknown) => {
        if (!stopped) sink.end(toPageAppCallError(error));
      },
    );
    return () => {
      stopped = true;
      cancel?.();
    };
  },
};
