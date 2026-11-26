// FILE: mossbot.ts
// Purpose: Shell half of `mossbot`: lets meeting / workspace Page Apps invite
// Mossbot assistants, post meeting notes, generate summaries, and ask in context.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const METHODS = new Set([
  "listBots",
  "joinMeeting",
  "postNote",
  "summarizeMeeting",
  "askInMeeting",
]);

export const mossbotShellPlugin: PageAppShellPlugin = {
  name: "mossbot",
  consent: "standing",
  modes: ["full", "embed"],
  label: "Moss 助手协同",
  purpose: "允许此应用页邀请 Moss 助手参会并整理纪要",
  rateLimit: { burst: 10, perMinute: 40 },
  call: (ctx, method, args) => {
    if (!METHODS.has(method)) {
      throw new PageAppCapabilityError("invalid_argument", `mossbot has no "${method}".`);
    }
    return ctx.serverCall(method, args);
  },
};
