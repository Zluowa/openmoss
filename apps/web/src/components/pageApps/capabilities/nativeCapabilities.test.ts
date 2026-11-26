import type { PageAppId, PageAppShellMessage, PageAppStoredConsent } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageAppBroker, type PageAppBrokerDeps, type PageAppBrokerSession } from "../broker";
import { PAGE_APP_SHELL_PLUGINS } from "./index";

const P = "moss-app/1";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  options: {
    capabilities?: Record<string, unknown>;
    consent?: Record<string, PageAppStoredConsent>;
    allow?: boolean;
    mode?: "full" | "embed" | "guest";
    onOpenSidechat?: PageAppBrokerDeps["onOpenSidechat"];
    serverCallImpl?: (input: {
      capability: string;
      method: string;
      args: unknown;
    }) => Promise<{ value: unknown }>;
  } = {},
) {
  const posted: PageAppShellMessage[] = [];
  let stored: Record<string, PageAppStoredConsent> = { ...options.consent };
  const askConsent = vi.fn(async () => options.allow ?? true);
  const call = vi.fn(
    options.serverCallImpl ??
      (async (input: { capability: string; method: string; args: unknown }) => ({
        value: { capability: input.capability, method: input.method, args: input.args },
      })),
  );
  const watch = vi.fn((_input: unknown, sink: { next: (v: unknown) => void; end: () => void }) => {
    sink.next({ type: "done", text: "streamed", model: "gpt-5" });
    return vi.fn();
  });
  const consent = vi.fn(
    async (input: { op: string; capability?: string; state?: PageAppStoredConsent | null }) => {
      if (input.op === "set" && input.capability) {
        if (input.state === null || input.state === undefined) delete stored[input.capability];
        else stored = { ...stored, [input.capability]: input.state };
      }
      return { consent: stored };
    },
  );
  const deps: PageAppBrokerDeps = {
    post: (message) => posted.push(message),
    client: { call, watch, consent } as unknown as PageAppBrokerDeps["client"],
    plugins: PAGE_APP_SHELL_PLUGINS,
    askConsent,
    confirm: vi.fn(async () => true),
    openPermissions: vi.fn(async () => undefined),
    ...(options.onOpenSidechat ? { onOpenSidechat: options.onOpenSidechat } : {}),
  };
  const session: PageAppBrokerSession = {
    appId: "app-native-1" as PageAppId,
    revision: 1,
    title: "Native App",
    mode: options.mode ?? "full",
    viewer: { id: "owner", name: "我", level: "owner", isOwner: true },
    capabilities: options.capabilities ?? { media: {}, chat: {}, mossbot: {}, voice: {} },
    consent: options.consent ?? {
      media: "granted",
      chat: "granted",
      mossbot: "granted",
      voice: "granted",
    },
  };
  const broker = new PageAppBroker(session, deps);
  const send = (message: Record<string, unknown>) =>
    broker.handleMessage({ protocol: P, ...message });
  const result = (id: number) => posted.find((m) => m.kind === "result" && m.id === id);
  return { broker, posted, send, result, askConsent, call };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PageApp shell native capabilities", () => {
  it("excludes media, chat, mossbot, and voice from guest init", () => {
    const { send, posted } = setup({
      mode: "guest",
      capabilities: { db: {}, media: {}, chat: {}, mossbot: {}, voice: {} },
    });
    send({ kind: "hello" });
    expect(posted[0]).toEqual({
      protocol: P,
      kind: "init",
      served: ["db", "permissions"],
    });
  });

  it("prompts once for standing consent on voice and routes openSidechat to host hook or fallback", async () => {
    const onOpenSidechat = vi.fn(async () => ({
      opened: true,
      mode: "sidechat" as const,
      threadId: "t-sidechat",
    }));
    const { send, result, askConsent } = setup({
      consent: { chat: "granted" },
      onOpenSidechat,
    });

    send({
      kind: "call",
      id: 1,
      capability: "chat",
      method: "openSidechat",
      args: { prompt: "Summarize", selectionText: "Alpha" },
    });
    await flush();
    expect(onOpenSidechat).toHaveBeenCalledWith({
      prompt: "Summarize",
      selectionText: "Alpha",
      appTitle: "Native App",
    });
    expect(result(1)).toMatchObject({
      ok: true,
      value: { opened: true, mode: "sidechat", threadId: "t-sidechat" },
    });

    send({ kind: "call", id: 2, capability: "voice", method: "listVoices", args: null });
    await flush();
    expect(askConsent).toHaveBeenCalledTimes(1);
    expect(result(2)).toMatchObject({ ok: true });
  });

  it("falls back to browser speechSynthesis when server TTS returns unavailable, and streams voice events", async () => {
    const speakSpy = vi.fn();
    const cancelSpy = vi.fn();
    class FakeUtterance {
      text: string;
      onend: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("window", {
      speechSynthesis: {
        speak: speakSpy,
        cancel: cancelSpy,
      },
    });

    const { send, posted, result } = setup({
      serverCallImpl: async ({ method }) => {
        if (method === "synthesize") {
          throw { code: "unavailable", message: "TTS unavailable offline" };
        }
        if (method === "startRealtimeSession") {
          return {
            value: {
              sessionId: "rtv-1",
              threadId: "page-app:app-native-1",
              voice: "breeze",
              transport: "server-bridge",
              status: "ready",
            },
          };
        }
        return { value: { stopped: true, sessionId: "rtv-1" } };
      },
    });

    send({ kind: "watch", id: 10, capability: "voice", method: "events", args: {} });
    await flush();

    send({
      kind: "call",
      id: 11,
      capability: "voice",
      method: "speak",
      args: { text: "你好 Moss" },
    });
    await flush();
    expect(cancelSpy).toHaveBeenCalled();
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(result(11)).toMatchObject({
      ok: true,
      value: { spoken: true, source: "browser" },
    });

    send({
      kind: "call",
      id: 12,
      capability: "voice",
      method: "startRealtimeSession",
      args: { voice: "breeze" },
    });
    await flush();
    expect(result(12)).toMatchObject({
      ok: true,
      value: { sessionId: "rtv-1", status: "ready" },
    });

    const voiceEvents = posted.filter((m) => m.kind === "event" && m.id === 10);
    expect(voiceEvents.length).toBeGreaterThanOrEqual(2);

    send({ kind: "call", id: 13, capability: "voice", method: "stopRealtimeSession", args: {} });
    await flush();
    expect(result(13)).toMatchObject({
      ok: true,
      value: { stopped: true, sessionId: "rtv-1" },
    });
  });
});
