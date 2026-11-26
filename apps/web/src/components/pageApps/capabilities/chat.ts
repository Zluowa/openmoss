// FILE: chat.ts
// Purpose: Shell half of `chat`: contextual Q&A (`ask`) and opening Moss's
// native sidechat in context (`openSidechat` / `summon`) with clean server fallback.
// Layer: Web pageApps capability

import type { PageAppChatOpenSidechatInput } from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const chatShellPlugin: PageAppShellPlugin = {
  name: "chat",
  consent: "standing",
  modes: ["full", "embed"],
  label: "对话与侧边提问",
  purpose: "允许此应用页向 Moss 提问或开启侧边对话",
  rateLimit: { burst: 8, perMinute: 30 },
  call: async (ctx, method, args) => {
    if (method === "ask") {
      return ctx.serverCall("ask", args);
    }
    if (method === "openSidechat" || method === "summon") {
      const payload = isRecord(args) ? (args as PageAppChatOpenSidechatInput) : {};
      const enriched: PageAppChatOpenSidechatInput = {
        ...payload,
        appTitle:
          typeof payload.appTitle === "string" && payload.appTitle ? payload.appTitle : ctx.title,
      };
      if (ctx.openSidechat) {
        try {
          const result = await ctx.openSidechat(enriched);
          if (result.opened) return result;
        } catch {
          // Fall back to inline contextual answer when host sidechat cannot open.
        }
      }
      return ctx.serverCall(method, enriched);
    }
    throw new PageAppCapabilityError("invalid_argument", `chat has no "${method}".`);
  },
  watch: (ctx, method, args, sink) => {
    if (method !== "ask") {
      sink.end({ code: "invalid_argument", message: `chat has no "${method}".` });
      return () => undefined;
    }
    return ctx.serverWatch("ask", args, sink);
  },
};
