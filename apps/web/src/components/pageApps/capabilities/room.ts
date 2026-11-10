// FILE: room.ts
// Purpose: Shell half of `room`: joins the page's live room for this window
// and remembers the peer the server assigned, so the page's `publish` and
// `setPresence` calls speak as that peer without the page handling ids.
// Layer: Web pageApps capability

import type { PageAppRoomEvent } from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellPlugin,
} from "@moss/shared/pageAppCapabilityPlugin";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The current peer per running frame (each broker has its own abort signal). */
const peers = new WeakMap<AbortSignal, string>();

export const roomShellPlugin: PageAppShellPlugin = {
  name: "room",
  consent: "standing",
  modes: ["full", "embed", "guest"],
  label: "实时互动",
  purpose: "让同时打开这个应用页的人看到彼此、实时互动。其他人会看到你的名字，内容不会保存。",
  rateLimit: { burst: 120, perMinute: 1_800 },
  call: (ctx, method, args) => {
    const peerId = peers.get(ctx.signal);
    switch (method) {
      case "publish":
      case "presence": {
        if (!peerId) throw new PageAppCapabilityError("not_found", "Join the room first.");
        const body = isRecord(args) ? args : {};
        return ctx.serverCall(method, { ...body, peerId });
      }
      case "peers":
        return ctx.serverCall("peers", null);
      default:
        throw new PageAppCapabilityError("invalid_argument", `room has no "${method}".`);
    }
  },
  watch: (ctx, method, args, sink) => {
    if (method !== "join") {
      sink.end({ code: "invalid_argument", message: `room has no "${method}".` });
      return () => undefined;
    }
    let mine: string | null = null;
    const cancel = ctx.serverWatch("join", isRecord(args) ? { state: args.state ?? null } : {}, {
      next: (value) => {
        const event = value as PageAppRoomEvent;
        if (event && event.type === "welcome") {
          mine = event.peerId;
          peers.set(ctx.signal, event.peerId);
        }
        sink.next(value);
      },
      end: (error) => {
        if (mine && peers.get(ctx.signal) === mine) peers.delete(ctx.signal);
        sink.end(error);
      },
    });
    return () => {
      if (mine && peers.get(ctx.signal) === mine) peers.delete(ctx.signal);
      cancel();
    };
  },
};
