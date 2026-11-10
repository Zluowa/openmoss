// FILE: ai.ts
// Purpose: Shell half of `ai`: one memoryless model request through Moss,
// streamed back to the page.
// Layer: Web pageApps capability

import type { PageAppShellPlugin } from "@moss/shared/pageAppCapabilityPlugin";

export const aiShellPlugin: PageAppShellPlugin = {
  name: "ai",
  consent: "standing",
  modes: ["full", "embed"],
  label: "使用 AI",
  purpose: "让这个应用页通过你的 Moss 账户向模型提问，会消耗你的额度。",
  rateLimit: { burst: 6, perMinute: 20 },
  watch: (ctx, method, args, sink) => {
    if (method !== "ask") {
      sink.end({ code: "invalid_argument", message: `ai has no "${method}".` });
      return () => undefined;
    }
    return ctx.serverWatch("ask", args, sink);
  },
};
