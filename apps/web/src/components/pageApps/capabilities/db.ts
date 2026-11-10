// FILE: db.ts
// Purpose: Shell half of `db`: relays to the server, which enforces the
// page's rules, the viewer's level and the document cap.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const CALLS = new Set(["get", "set", "update", "delete", "query", "acquire"]);
const WATCHES = new Set(["watchDoc", "watchQuery"]);

export const dbShellPlugin: PageAppShellPlugin = {
  name: "db",
  consent: "standing",
  modes: ["full", "embed", "guest"],
  label: "保存数据",
  purpose: "在这个应用页里保存和读取数据，打开它的人能看到共享的部分。",
  rateLimit: { burst: 120, perMinute: 600 },
  call: (ctx, method, args) => {
    if (!CALLS.has(method))
      throw new PageAppCapabilityError("invalid_argument", `db has no "${method}".`);
    return ctx.serverCall(method, args);
  },
  watch: (ctx, method, args, sink) => {
    if (!WATCHES.has(method)) {
      sink.end({ code: "invalid_argument", message: `db has no "${method}".` });
      return () => undefined;
    }
    return ctx.serverWatch(method, args, sink);
  },
};
