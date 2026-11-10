// FILE: user.ts
// Purpose: Shell half of `user`: who is viewing, and what they may change.
// Layer: Web pageApps capability

import { pageAppDbAllows, pageAppDbRulesFromConfig } from "@moss/shared/pageAppDbRules";
import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

export const userShellPlugin: PageAppShellPlugin = {
  name: "user",
  consent: "none",
  modes: ["full", "embed", "guest"],
  label: "查看访问者",
  purpose: "让这个应用页知道是谁在看它。",
  call: (ctx, method, args) => {
    if (method === "me") {
      const { id, name, level, isOwner } = ctx.viewer;
      return Promise.resolve({ id, name, level, isOwner });
    }
    if (method === "can") {
      const what = args && typeof args === "object" ? (args as { what?: unknown }).what : undefined;
      if (what === "data.write" || what === "data.read") {
        if (!("db" in ctx.capabilities)) return Promise.resolve(false);
        const rules = pageAppDbRulesFromConfig(ctx.capabilities.db);
        return Promise.resolve(
          pageAppDbAllows(
            rules,
            ctx.viewer,
            "shared/probe",
            what === "data.write" ? "write" : "read",
          ),
        );
      }
      if (what === "page.publish")
        return Promise.resolve(ctx.viewer.level === "owner" || ctx.viewer.level === "admin");
      return Promise.resolve(null);
    }
    throw new PageAppCapabilityError("invalid_argument", `user has no "${method}".`);
  },
};
