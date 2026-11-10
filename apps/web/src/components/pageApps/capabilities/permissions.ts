// FILE: permissions.ts
// Purpose: Shell half of the built-in `permissions` capability.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const MAX_MANAGE_PER_LOAD = 3;

export const permissionsShellPlugin: PageAppShellPlugin = (() => {
  const opened = new WeakMap<AbortSignal, number>();
  return {
    name: "permissions",
    consent: "none",
    modes: ["full", "embed", "guest"],
    label: "权限",
    purpose: "让这个应用页查看和请求它的权限。",
    call: async (ctx, method, args) => {
      const field = (key: string) =>
        args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
      if (method === "state") {
        const states = ctx.permissionStates();
        const name = field("name");
        return typeof name === "string" ? (states[name] ?? "unavailable") : states;
      }
      if (method === "request") {
        const names = field("names");
        return ctx.requestPermissions(
          Array.isArray(names)
            ? names.filter((n): n is string => typeof n === "string").slice(0, 32)
            : undefined,
        );
      }
      if (method === "manage") {
        const count = opened.get(ctx.signal) ?? 0;
        if (count >= MAX_MANAGE_PER_LOAD)
          throw new PageAppCapabilityError(
            "unavailable",
            "The permissions panel was opened too often.",
          );
        opened.set(ctx.signal, count + 1);
        await ctx.managePermissions();
        return null;
      }
      throw new PageAppCapabilityError("invalid_argument", `permissions has no "${method}".`);
    },
  };
})();
