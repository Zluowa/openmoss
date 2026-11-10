// FILE: page.ts
// Purpose: Shell half of `page`: metadata, and publishing a new version of
// the page after the viewer confirms it.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

export const pageShellPlugin: PageAppShellPlugin = {
  name: "page",
  consent: "none",
  modes: ["full", "embed"],
  label: "更新应用页",
  purpose: "让这个应用页发布自己的新版本。",
  rateLimit: { burst: 3, perMinute: 6 },
  call: async (ctx, method, args) => {
    if (method === "metadata") return ctx.serverCall("metadata", null);
    if (method === "publish") {
      const ok = await ctx.confirm({
        title: "发布新版本？",
        body: `「${ctx.title}」想用新的内容替换自己。旧版本会保留在历史里。`,
        confirmLabel: "发布",
      });
      if (!ok) throw new PageAppCapabilityError("not_granted", "The viewer did not publish.");
      return ctx.serverCall("publish", args);
    }
    throw new PageAppCapabilityError("invalid_argument", `page has no "${method}".`);
  },
};
