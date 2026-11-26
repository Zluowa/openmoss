// FILE: media.ts
// Purpose: Shell half of `media`: image and video generation through the
// viewer's Moss account. Standing consent per page; guests are excluded.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const METHODS = new Set(["listModels", "generateImage", "generateVideo", "getJob"]);

export const mediaShellPlugin: PageAppShellPlugin = {
  name: "media",
  consent: "standing",
  modes: ["full", "embed"],
  label: "媒体生成",
  purpose: "允许此应用页生成图片和视频并消耗账户额度",
  rateLimit: { burst: 4, perMinute: 15 },
  call: (ctx, method, args) => {
    if (!METHODS.has(method)) {
      throw new PageAppCapabilityError("invalid_argument", `media has no "${method}".`);
    }
    return ctx.serverCall(method, args);
  },
};
