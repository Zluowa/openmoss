// FILE: comments.ts
// Purpose: Shell half of `comments`: a page asks Moss to open its comment
// composer next to an element (the page passes the element's box inside the
// frame); posting writes to the page's comment store. Listing, resolving and
// watching relay to the server, which checks who may do what.
// Layer: Web pageApps capability

import {
  PageAppCapabilityError,
  type PageAppShellContext,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

import { openPageAppCommentComposer } from "../PageAppCommentComposer";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

async function compose(ctx: PageAppShellContext, args: unknown) {
  if (!isRecord(args) || !isRecord(args.anchor))
    throw new PageAppCapabilityError("invalid_argument", "open() needs an element or an anchor.");
  const box = isRecord(args.rect) ? args.rect : {};
  const frame = ctx.frameElement()?.getBoundingClientRect() ?? null;
  const target = frame
    ? {
        left: frame.left + Math.min(Math.max(finite(box.x), 0), frame.width),
        top: frame.top + Math.min(Math.max(finite(box.y), 0), frame.height),
        width: Math.max(0, finite(box.width)),
        height: Math.max(0, finite(box.height)),
      }
    : { left: window.innerWidth / 2 - 150, top: window.innerHeight / 3, width: 0, height: 0 };
  const anchor = args.anchor;
  const posted = await openPageAppCommentComposer({
    pageTitle: ctx.title,
    anchor: {
      target: typeof anchor.target === "string" ? anchor.target : "",
      label: typeof anchor.label === "string" ? anchor.label : "",
      x: finite(anchor.x, 0.5),
      y: finite(anchor.y, 0.5),
      quote: typeof anchor.quote === "string" ? anchor.quote : null,
    },
    target,
    post: (body) => ctx.serverCall("add", { anchor, body }),
    signal: ctx.signal,
  });
  return posted ?? { cancelled: true };
}

export const commentsShellPlugin: PageAppShellPlugin = {
  name: "comments",
  consent: "none",
  modes: ["full", "embed", "guest"],
  label: "评论",
  purpose: "让这个应用页打开 Moss 的评论框，并显示页面上的评论。",
  rateLimit: { burst: 30, perMinute: 120 },
  call: (ctx, method, args) => {
    switch (method) {
      case "open":
        return compose(ctx, args);
      case "list":
        return ctx.serverCall("list", null);
      case "resolve":
      case "edit":
      case "delete":
        return ctx.serverCall(method, args);
      default:
        throw new PageAppCapabilityError("invalid_argument", `comments has no "${method}".`);
    }
  },
  watch: (ctx, method, args, sink) => {
    if (method !== "watch") {
      sink.end({ code: "invalid_argument", message: `comments has no "${method}".` });
      return () => undefined;
    }
    return ctx.serverWatch("watch", args, sink);
  },
};
