import { randomUUID } from "node:crypto";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  PAGE_APP_VOICE_MAX_AUDIO_BASE64_CHARS,
  type PageApp,
  type PageAppAiEvent,
} from "@moss/contracts";
import { Effect, Layer, Stream } from "effect";

import { PAGE_APP_AUTHOR_GUIDE } from "../../../agentGateway/pageAppAuthorGuide";
import { makePageAppTools } from "../../../agentGateway/pageAppTools";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite";
import type { PageAppAiGateway, PageAppAiGatewayRequest } from "../aiGateway";
import { makePageAppsServiceShape, PageAppsService, LOCAL_OWNER_VIEWER } from "../PageAppsService";
import type { PageAppMediaGateway } from "./media";
import { makeMossbotCapabilityGateway } from "./mossbot";
import { makePageAppVoiceGateway } from "./voice";

const local = { kind: "local-user" } as const;
const pairedGuestViewer = {
  id: "client:paired-guest",
  name: "访客",
  level: "view",
  isOwner: false,
} as const;
const baseHtml = "<!doctype html><html><head><title>Native Caps</title></head><body></body></html>";

const fakeAi: PageAppAiGateway = {
  ask: async function* (
    request: PageAppAiGatewayRequest,
    _signal: AbortSignal,
  ): AsyncGenerator<PageAppAiEvent> {
    const body =
      (request.system ?? "") +
      "\n" +
      (typeof request.input === "string"
        ? request.input
        : request.input.map((msg) => msg.content).join("\n"));
    if (body.includes("JSON")) {
      const json = JSON.stringify({
        summary: "会议达成发布结论",
        keyPoints: ["完成核心能力"],
        actionItems: ["周五上线"],
        decisions: ["启用 Moss 语音"],
      });
      yield { type: "text", delta: json };
      yield { type: "done", text: json, model: "gpt-5" };
      return;
    }
    yield { type: "text", delta: "来自 Moss 的" };
    yield { type: "text", delta: "上下文回答" };
    yield { type: "done", text: "来自 Moss 的上下文回答", model: "gpt-5" };
  },
};

const fakeMedia: PageAppMediaGateway = {
  listModels: async () => [
    {
      id: "gpt-image-2.5-flare",
      kind: "image",
      label: "GPT Image 2.5 Flare",
      description: "Fast image generation",
      available: true,
      isDefault: true,
    },
  ],
  generate: async ({ kind, args }) => ({
    jobId: `job_${kind}_1`,
    kind,
    modelId: String(args.modelId ?? "gpt-image-2.5-flare"),
    prompt: String(args.prompt ?? ""),
    status: "succeeded",
    url: "/__moss_app/asset/asset-1",
    urls: ["/__moss_app/asset/asset-1"],
    assetPaths: ["/__moss_app/asset/asset-1"],
    createdAt: "2026-11-27T00:00:00Z",
  }),
  getJob: async ({ jobId }) => ({
    jobId,
    kind: "image",
    modelId: "gpt-image-2.5-flare",
    prompt: "done",
    status: "succeeded",
    url: "/__moss_app/asset/asset-1",
    urls: ["/__moss_app/asset/asset-1"],
    assetPaths: ["/__moss_app/asset/asset-1"],
    createdAt: "2026-11-27T00:00:00Z",
  }),
};

const fakeMossbot = makeMossbotCapabilityGateway({
  ai: fakeAi,
  listActiveBots: async () => [
    { id: "bot-pm", name: "产品 Mossbot", icon: null, color: "#4f46e5" },
  ],
  ensureRoom: async ({ name }) => ({ roomId: `room:${name}` }),
  postToRoom: async () => undefined,
});

const fakeVoice = makePageAppVoiceGateway({
  resolveCredential: async () => ({
    gatewayBaseUrl: "https://gateway.example.test",
    accessToken: "test-token",
  }),
  fetchImpl: (async (url: string | Request | URL) => {
    if (String(url).endsWith("/v1/audio/speech")) {
      return new Response(new Uint8Array([73, 68, 51, 1]), { status: 200 });
    }
    return new Response(JSON.stringify({ text: "识别出的语音文本" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch,
});

const layer = Layer.effect(
  PageAppsService,
  makePageAppsServiceShape({
    ai: fakeAi,
    media: fakeMedia,
    mossbot: fakeMossbot,
    voice: fakeVoice,
  }),
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const tests = it.layer(layer);

const createWithCaps = (capabilities: Record<string, unknown>) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    return (yield* service.mutate(
      {
        op: "create",
        requestId: randomUUID(),
        scopeSpaceId: null,
        html: baseHtml,
        capabilities,
      },
      local,
    )).app;
  });

const grantAll = (app: PageApp, names: readonly string[], viewer = LOCAL_OWNER_VIEWER) =>
  Effect.gen(function* () {
    const service = yield* PageAppsService;
    for (const capability of names) {
      yield* service.consent({ op: "set", appId: app.id, capability, state: "granted" }, viewer);
    }
  });

tests("PageApps native capabilities server layer", (it) => {
  it.effect("serves media, chat, mossbot, and voice calls once declared and granted", () =>
    Effect.gen(function* () {
      const service = yield* PageAppsService;
      const app = yield* createWithCaps({
        media: {},
        chat: {},
        mossbot: {},
        voice: {},
      });
      yield* grantAll(app, ["media", "chat", "mossbot", "voice"]);

      const models = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "media",
          method: "listModels",
          args: null,
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.isTrue(Array.isArray(models.value));

      const image = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "media",
          method: "generateImage",
          args: { prompt: "Sunset over river" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((image.value as { jobId: string }).jobId, "job_image_1");

      const chatStream = yield* Stream.runCollect(
        service.watch(
          {
            appId: app.id,
            revision: app.revision,
            capability: "chat",
            method: "ask",
            args: { prompt: "总结一下", selectionText: "关键引用", appTitle: "阅读器" },
          },
          local,
          LOCAL_OWNER_VIEWER,
        ),
      );
      const events = Array.from(chatStream).map(
        (item) => item.value as { type: string; text?: string },
      );
      assert.equal(events.at(-1)?.type, "done");

      const sidechatFallback = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "chat",
          method: "openSidechat",
          args: { prompt: "解释这一段", selectionText: "引用片段" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((sidechatFallback.value as { mode: string }).mode, "inline");

      const joined = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "mossbot",
          method: "joinMeeting",
          args: { meetingId: "meet-1", title: "周会同步", botId: "bot-pm" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((joined.value as { joined: boolean }).joined, true);

      yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "mossbot",
          method: "postNote",
          args: { meetingId: "meet-1", author: "Alice", text: "周五上线", kind: "decision" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );

      const summary = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "mossbot",
          method: "summarizeMeeting",
          args: { meetingId: "meet-1" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((summary.value as { summary: string }).summary, "会议达成发布结论");

      const voices = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "voice",
          method: "listVoices",
          args: null,
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((voices.value as { defaultVoice: string }).defaultVoice, "breeze");

      const tts = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "voice",
          method: "synthesize",
          args: { text: "你好 Moss", voice: "breeze", format: "mp3" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((tts.value as { mimeType: string }).mimeType, "audio/mpeg");

      const rt = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "voice",
          method: "startRealtimeSession",
          args: { voice: "breeze", instructions: "Help me review" },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      const sessionId = (rt.value as { sessionId: string }).sessionId;
      assert.isTrue(sessionId.startsWith("rtv_"));

      const stopped = yield* service.call(
        {
          appId: app.id,
          revision: app.revision,
          capability: "voice",
          method: "stopRealtimeSession",
          args: { sessionId },
        },
        local,
        LOCAL_OWNER_VIEWER,
      );
      assert.equal((stopped.value as { stopped: boolean }).stopped, true);
    }),
  );

  it.effect(
    "blocks paired non-owner guests across media, chat, mossbot, and voice and enforces voice payload limits",
    () =>
      Effect.gen(function* () {
        const service = yield* PageAppsService;
        const app = yield* createWithCaps({ media: {}, chat: {}, mossbot: {}, voice: {} });
        yield* grantAll(app, ["media", "chat", "mossbot", "voice"], LOCAL_OWNER_VIEWER);
        yield* grantAll(app, ["media", "chat", "mossbot", "voice"], pairedGuestViewer);

        const guestMedia = yield* service
          .call(
            {
              appId: app.id,
              revision: app.revision,
              capability: "media",
              method: "listModels",
              args: null,
            },
            local,
            pairedGuestViewer,
          )
          .pipe(Effect.exit);
        assert.isTrue(guestMedia._tag === "Failure");

        const guestChatCall = yield* service
          .call(
            {
              appId: app.id,
              revision: app.revision,
              capability: "chat",
              method: "openSidechat",
              args: { prompt: "hi" },
            },
            local,
            pairedGuestViewer,
          )
          .pipe(Effect.exit);
        assert.isTrue(guestChatCall._tag === "Failure");

        const guestChatWatch = yield* Stream.runCollect(
          service.watch(
            {
              appId: app.id,
              revision: app.revision,
              capability: "chat",
              method: "ask",
              args: { prompt: "hi" },
            },
            local,
            pairedGuestViewer,
          ),
        ).pipe(Effect.exit);
        assert.isTrue(guestChatWatch._tag === "Failure");

        const guestMossbot = yield* service
          .call(
            {
              appId: app.id,
              revision: app.revision,
              capability: "mossbot",
              method: "listBots",
              args: null,
            },
            local,
            pairedGuestViewer,
          )
          .pipe(Effect.exit);
        assert.isTrue(guestMossbot._tag === "Failure");

        const guestVoice = yield* service
          .call(
            {
              appId: app.id,
              revision: app.revision,
              capability: "voice",
              method: "listVoices",
              args: null,
            },
            local,
            pairedGuestViewer,
          )
          .pipe(Effect.exit);
        assert.isTrue(guestVoice._tag === "Failure");

        const tooLarge = yield* service
          .call(
            {
              appId: app.id,
              revision: app.revision,
              capability: "voice",
              method: "transcribe",
              args: { audioBase64: "A".repeat(PAGE_APP_VOICE_MAX_AUDIO_BASE64_CHARS + 1) },
            },
            local,
            LOCAL_OWNER_VIEWER,
          )
          .pipe(Effect.exit);
        assert.isTrue(tooLarge._tag === "Failure");
      }),
  );
});

describe("PAGE_APP_AUTHOR_GUIDE & agentGateway tools", () => {
  it("documents media, chat, mossbot, voice, and moss-ui-kit defaults", () => {
    for (const token of [
      'moss.use("media")',
      'moss.use("chat")',
      'moss.use("mossbot")',
      'moss.use("voice")',
      "moss-ui-kit",
      "MossButton",
      "MossCard",
      "MossTabs",
      "MossDrawer",
      "MossDialog",
      "MossBadge",
      "MossToast",
      "MossMarkdown",
      "MossSelectionAsk",
      "MossCompanionDrawer",
      "MossbotMeetingBar",
      "MossVoiceButton",
      "MossRealtimeVoiceBar",
      "MossMediaTrigger",
    ]) {
      expect(PAGE_APP_AUTHOR_GUIDE).toContain(token);
    }

    const tools = makePageAppTools({ apps: {} as never });
    const guideTool = tools.find((tool) => tool.definition.name === "moss_app_guide");
    const publishTool = tools.find((tool) => tool.definition.name === "moss_app_publish");
    expect(guideTool?.definition.description).toContain("voice");
    expect(guideTool?.definition.description).toContain("moss-ui-kit");
    expect(
      (
        publishTool?.definition.inputSchema as {
          properties?: { capabilities?: { description?: string } };
        }
      ).properties?.capabilities?.description,
    ).toContain("voice");
  });
});
