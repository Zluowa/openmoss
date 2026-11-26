import type { PageAppId } from "@moss/contracts";
import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageAppBroker, type PageAppBrokerDeps, type PageAppBrokerSession } from "../broker";
import { PAGE_APP_SHELL_PLUGINS } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Native capabilities inside real iframe runtime (browser)", () => {
  it("runs media, chat, mossbot, and voice inside a sandboxed iframe bridged to PageAppBroker", async () => {
    const parentOrigin = window.location.origin;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    document.body.appendChild(iframe);

    const html = injectPageAppFrameRuntime(
      `<!doctype html>
<html>
  <head><title>Native Caps Frame</title></head>
  <body>
    <script>
      (async function () {
        var results = {};
        var media = await moss.use("media");
        var img = await media.generateImage({ prompt: "Misty mountain dawn" });
        results.mediaUrl = img.url;

        var chat = await moss.use("chat");
        var sidechat = await chat.openSidechat({ prompt: "Analyze", selectionText: "Quote A" });
        results.sidechatOpened = sidechat.opened;

        var mossbot = await moss.use("mossbot");
        var meeting = await mossbot.joinMeeting({ meetingId: "m-browser", title: "Review" });
        results.meetingJoined = meeting.joined;

        var voice = await moss.use("voice");
        var stateEvents = [];
        var off = voice.onState(function (ev) { stateEvents.push(ev.phase); });
        var rt = await voice.startRealtimeSession({ voice: "breeze" });
        await voice.stopRealtimeSession({ sessionId: rt.sessionId });
        off();
        results.voiceSession = rt.sessionId;
        results.voicePhases = stateEvents;

        window.parent.postMessage({ type: "native-caps-test-done", results: results }, ${JSON.stringify(parentOrigin)});
      })().catch(function (err) {
        window.parent.postMessage({ type: "native-caps-test-error", message: String(err && err.message || err) }, ${JSON.stringify(parentOrigin)});
      });
    </script>
  </body>
</html>`,
      buildPageAppFrameRuntime({ parentOrigin }),
    );

    const session: PageAppBrokerSession = {
      appId: "app-browser-1" as PageAppId,
      revision: 1,
      title: "Browser Fixture",
      mode: "full",
      viewer: { id: "owner", name: "我", level: "owner", isOwner: true },
      capabilities: { media: {}, chat: {}, mossbot: {}, voice: {} },
      consent: { media: "granted", chat: "granted", mossbot: "granted", voice: "granted" },
    };

    const deps: PageAppBrokerDeps = {
      post: (msg) => iframe.contentWindow?.postMessage(msg, "*"),
      client: {
        call: async (input: { capability: string; method: string }) => {
          if (input.capability === "media" && input.method === "generateImage") {
            return {
              value: {
                jobId: "job-b-1",
                kind: "image",
                modelId: "gpt-image-2.5-flare",
                prompt: "Misty mountain dawn",
                status: "succeeded",
                url: "data:image/png;base64,AA==",
                urls: ["data:image/png;base64,AA=="],
                dataUrls: ["data:image/png;base64,AA=="],
                createdAt: "2026-11-27T00:00:00Z",
              },
            };
          }
          if (input.capability === "mossbot" && input.method === "joinMeeting") {
            return {
              value: {
                meetingId: "m-browser",
                roomId: null,
                title: "Review",
                joined: true,
                bots: [],
                notesCount: 0,
              },
            };
          }
          if (input.capability === "voice" && input.method === "startRealtimeSession") {
            return {
              value: {
                sessionId: "rtv-browser-1",
                threadId: "page-app:app-browser-1",
                voice: "breeze",
                transport: "server-bridge",
                status: "ready",
              },
            };
          }
          if (input.capability === "voice" && input.method === "stopRealtimeSession") {
            return { value: { stopped: true, sessionId: "rtv-browser-1" } };
          }
          return { value: null };
        },
        watch: () => () => undefined,
        consent: async () => ({ consent: session.consent }),
      } as unknown as PageAppBrokerDeps["client"],
      plugins: PAGE_APP_SHELL_PLUGINS,
      askConsent: async () => true,
      confirm: async () => true,
      openPermissions: async () => undefined,
      onOpenSidechat: async () => ({ opened: true, mode: "sidechat", threadId: "t-b-1" }),
    };

    const broker = new PageAppBroker(session, deps);

    try {
      const done = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("Timed out waiting for iframe")),
          10_000,
        );
        const onMessage = (event: MessageEvent) => {
          if (event.source !== iframe.contentWindow) return;
          const data = event.data as Record<string, unknown> | null;
          if (!data || typeof data !== "object") return;
          if (data.type === "native-caps-test-done") {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolve(data.results as Record<string, unknown>);
            return;
          }
          if (data.type === "native-caps-test-error") {
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            reject(new Error(String(data.message)));
            return;
          }
          broker.handleMessage(data);
        };
        window.addEventListener("message", onMessage);
        iframe.srcdoc = html;
      });

      expect(done.mediaUrl).toBe("data:image/png;base64,AA==");
      expect(done.sidechatOpened).toBe(true);
      expect(done.meetingJoined).toBe(true);
      expect(done.voiceSession).toBe("rtv-browser-1");
      expect(done.voicePhases).toEqual(["ready", "inactive"]);
    } finally {
      broker.dispose();
      iframe.remove();
    }
  });
});
