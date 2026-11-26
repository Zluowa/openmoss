// FILE: MossUiKit.browser.tsx
// Purpose: Real headless Chromium verification for Moss UI Kit inside production opaque CSP
//          sandboxes: interactive Handbook, WeChat Read non-invasive selection-ask + drawer,
//          Smart Meeting Room native voice + Mossbot + media trigger, and strict CSS isolation.
// Layer: Web browser tests

import { pageAppContentSecurityPolicy } from "@moss/shared/pageAppContentPolicy";
import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import {
  MOSS_UI_KIT_CATALOG,
  mountButton,
  mountCard,
  mountCompanionDrawer,
  mountDrawer,
  mountMarkdown,
  mountMediaTrigger,
  mountMossbotMeetingBar,
  mountSelectionAsk,
  registerMossUIKit,
} from "@moss/shared/pageAppUiKit";
import {
  buildMeetingRoomUiKitFixtureHtml,
  buildMossUiKitHandbookHtml,
  buildWechatReadUiKitFixtureHtml,
} from "@moss/shared/pageAppUiKitHandbook";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { pageAppIframeSandbox } from "./AppPageFrame";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    beginAppThumbnailRequestProbe: (appTitle?: string, readonlyHost?: boolean) => Promise<void>;
    endAppThumbnailRequestProbe: () => Promise<
      { resourceType: string; local: boolean; appFrame: boolean }[]
    >;
    prepareAppLibraryFixture: (html: string) => Promise<{ html: string; offlineReady: boolean }>;
  }
}

const TMP_SCREENSHOT_DIR = "../../../.tmp/app-ui-kit";

const cspMeta = () =>
  pageAppContentSecurityPolicy({ parentOrigin: window.location.origin, opaque: true })
    .split("; ")
    .filter(
      (directive) => !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "),
    )
    .join("; ");

function attachBrokerBridge(
  served: readonly string[],
  handler: {
    readonly call: (capability: string, method: string, args: unknown) => unknown;
    readonly watch?: (
      capability: string,
      method: string,
      args: unknown,
      emit: (value: unknown) => void,
      end: () => void,
    ) => void;
  },
): () => void {
  const onMessage = (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.protocol !== "moss-app/1") return;
    const target = event.source as Window | null;
    if (!target) return;
    if (msg.kind === "hello") {
      console.log("[DEBUG] parent received hello from iframe!");
      target.postMessage({ protocol: "moss-app/1", kind: "init", served }, "*");
      return;
    }
    if (msg.kind === "call") {
      const id = msg.id;
      const cap = String(msg.capability ?? "");
      const method = String(msg.method ?? "");
      Promise.resolve()
        .then(() => handler.call(cap, method, msg.args))
        .then((value) => {
          target.postMessage({ protocol: "moss-app/1", kind: "result", id, ok: true, value }, "*");
        })
        .catch((err: unknown) => {
          target.postMessage(
            {
              protocol: "moss-app/1",
              kind: "result",
              id,
              ok: false,
              error: { code: "unavailable", message: String(err) },
            },
            "*",
          );
        });
      return;
    }
    if (msg.kind === "watch") {
      const id = msg.id;
      const cap = String(msg.capability ?? "");
      const method = String(msg.method ?? "");
      const emit = (value: unknown) =>
        target.postMessage({ protocol: "moss-app/1", kind: "event", id, value }, "*");
      const end = () => target.postMessage({ protocol: "moss-app/1", kind: "end", id }, "*");
      if (handler.watch) {
        handler.watch(cap, method, msg.args, emit, end);
      } else {
        end();
      }
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADklEQVQI12NgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Moss UI Kit non-invasive Shadow DOM library", () => {
  it("serves and renders the interactive Handbook (Core Primitives, Voice, Widgets) in the opaque CSP sandbox", async () => {
    await page.viewport(1280, 800);
    await commands.beginAppThumbnailRequestProbe("Moss UI Kit Handbook");
    const prepared = await commands.prepareAppLibraryFixture(
      buildMossUiKitHandbookHtml({ cspMeta: cspMeta() }),
    );
    expect(prepared.offlineReady).toBe(true);

    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({
        parentOrigin: window.location.origin,
      }),
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const detach = attachBrokerBridge(["ai", "chat", "mossbot", "voice", "media", "permissions"], {
      call: () => ({ text: "手册演示回复" }),
    });

    let frameLoaded = false;
    const mounted = await render(
      <iframe
        title="Moss UI Kit Handbook"
        src={url}
        sandbox={pageAppIframeSandbox(true)}
        onLoad={() => {
          frameLoaded = true;
        }}
        style={{ width: "100vw", height: "100vh", border: 0, display: "block" }}
      />,
    );

    try {
      await vi.waitFor(() => expect(frameLoaded).toBe(true), { timeout: 5_000 });
      const frame = page.frameLocator(page.getByTitle("Moss UI Kit Handbook"));
      await expect
        .element(frame.getByText("Moss 原生 UI 套件手册"), { timeout: 4_000 })
        .toBeVisible();
      await expect.element(frame.getByText("v1.0.0 · 14 组件")).toBeVisible();
      await expect
        .element(frame.getByText("14 个开箱即用原生组件，完全隔离宿主 CSS。"))
        .toBeVisible();

      await frame.getByRole("tab", { name: "设计令牌" }).click();
      await expect
        .element(frame.getByText("自动适配 --moss-paper / --moss-ink 明暗双主题。"))
        .toBeVisible();

      await frame.getByRole("button", { name: "触发 MossToast" }).click();
      await expect.element(frame.getByText("Moss 轻提示已触发")).toBeVisible();

      await frame.getByRole("button", { name: "打开 MossDialog" }).click();
      await expect.element(frame.getByText("Moss 原生弹窗")).toBeVisible();
      await frame.getByRole("button", { name: "知道了" }).click();
      await expect.element(frame.getByText("Moss 原生弹窗")).not.toBeVisible();

      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
      await page.screenshot({ path: `${TMP_SCREENSHOT_DIR}/ui-kit-01-handbook.png` });
    } finally {
      detach();
      await mounted.unmount();
      URL.revokeObjectURL(url);
      await commands.endAppThumbnailRequestProbe();
    }
  });

  it("WeChat Read showcase: keeps host parchment CSS isolated and completes highlight + selection ask into MossCompanionDrawer", async () => {
    await page.viewport(1280, 800);
    await commands.beginAppThumbnailRequestProbe("WeChat Read UI Kit");
    const prepared = await commands.prepareAppLibraryFixture(
      buildWechatReadUiKitFixtureHtml({ cspMeta: cspMeta() }),
    );
    expect(prepared.offlineReady).toBe(true);

    // Use production main frame plugins (only `ai` present, verifying clean fallback when `chat` is absent).
    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({ parentOrigin: window.location.origin }),
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const aiRequests: Array<{ prompt: unknown; system: unknown }> = [];
    const detach = attachBrokerBridge(["ai", "permissions"], {
      call: () => null,
      watch: (cap, method, args, emit, end) => {
        if (cap === "ai" && method === "ask") {
          const payload = args as { input?: unknown; system?: unknown };
          aiRequests.push({ prompt: payload.input, system: payload.system });
          emit({ type: "text", delta: "这段话说明界面应当保持克制，" });
          emit({ type: "text", delta: "Shadow DOM 隔离确保了零样式污染。" });
        }
        end();
      },
    });

    let frameLoaded = false;
    const mounted = await render(
      <iframe
        title="WeChat Read UI Kit"
        src={url}
        sandbox={pageAppIframeSandbox(true)}
        onLoad={() => {
          frameLoaded = true;
        }}
        style={{ width: "100vw", height: "100vh", border: 0, display: "block" }}
      />,
    );

    try {
      await vi.waitFor(() => expect(frameLoaded).toBe(true), { timeout: 5_000 });
      const frame = page.frameLocator(page.getByTitle("WeChat Read UI Kit"));
      await expect.element(frame.getByText("第一章 · 纸面与留白")).toBeVisible();
      await expect.element(frame.getByText("宿主页签按钮")).toBeVisible();

      // Verify host parchment CSS did not bleed into Shadow DOM drawer or button, and host stayed parchment.
      const iframeEl = page.getByTitle("WeChat Read UI Kit").element() as HTMLIFrameElement;
      const doc = iframeEl.contentDocument!;
      const win = iframeEl.contentWindow!;
      const hostBodyBg = win.getComputedStyle(doc.body).backgroundColor;
      const hostBtnBorder = win.getComputedStyle(
        doc.querySelector("#host-bookmark-btn")!,
      ).borderStyle;
      const drawerEl = doc.querySelector("#wechat-drawer")!;
      const drawerBg = win.getComputedStyle(
        drawerEl.shadowRoot!.querySelector(".shell")!,
      ).backgroundColor;
      const drawerToggleBorder = win.getComputedStyle(
        drawerEl.shadowRoot!.querySelector('[data-moss-role="toggle"]')!,
      ).borderStyle;
      expect(hostBodyBg).toBe("rgb(244, 236, 216)");
      expect(hostBtnBorder).toBe("dashed");
      expect(drawerBg).toBe("rgb(244, 243, 239)");
      expect(drawerToggleBorder).toBe("solid");

      // Select text in paragraph 1 and highlight amber.
      await userEvent.dblClick(frame.getByText("真正的工具应当像空气一样存在"));
      const amberBtn = frame.getByRole("button", { name: "琥珀黄" });
      await expect.element(amberBtn).toBeVisible();
      await amberBtn.click();
      await expect.element(frame.getByText("已添加划线")).toBeVisible();
      const highlightCount = doc.querySelectorAll(
        '#para-1 mark[data-moss-ui-highlight="amber"]',
      ).length;
      expect(highlightCount).toBeGreaterThanOrEqual(1);

      // Select "Shadow DOM" in paragraph 2, open inline prompt, and ask Moss -> streams into MossCompanionDrawer.
      const para2Text = doc.getElementById("para-2")?.firstChild;
      expect(para2Text).toBeTruthy();
      const range2 = doc.createRange();
      const rawPara2 = para2Text!.textContent ?? "";
      const shadowIdx = rawPara2.indexOf("Shadow DOM");
      expect(shadowIdx).toBeGreaterThanOrEqual(0);
      range2.setStart(para2Text!, shadowIdx);
      range2.setEnd(para2Text!, shadowIdx + "Shadow DOM".length);
      const sel2 = win.getSelection()!;
      sel2.removeAllRanges();
      sel2.addRange(range2);
      doc.dispatchEvent(new Event("selectionchange"));
      doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      const askOpenBtn = frame.getByRole("button", { name: "划线提问" });
      await expect.element(askOpenBtn).toBeVisible();
      await askOpenBtn.click();

      const promptInput = frame.getByPlaceholder("对选中内容向 Moss 提问…");
      await expect.element(promptInput).toBeVisible();
      await promptInput.fill("请解读这段架构隔离原理");
      await frame.getByRole("button", { name: "问 Moss" }).click();

      await expect
        .element(frame.getByText("这段话说明界面应当保持克制，Shadow DOM 隔离确保了零样式污染。"))
        .toBeVisible();
      expect(aiRequests).toHaveLength(1);
      expect(String(aiRequests[0]?.system)).toContain("Shadow");
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);

      await page.screenshot({
        path: `${TMP_SCREENSHOT_DIR}/ui-kit-02-wechat-read-selection-ask.png`,
      });
    } finally {
      detach();
      await mounted.unmount();
      URL.revokeObjectURL(url);
      await commands.endAppThumbnailRequestProbe();
    }
  });

  it("Smart Meeting Room showcase: verifies native Voice dictation + Realtime Voice + Mossbot summary + Media trigger", async () => {
    await page.viewport(1280, 800);
    await commands.beginAppThumbnailRequestProbe("Meeting Room UI Kit");
    const prepared = await commands.prepareAppLibraryFixture(
      buildMeetingRoomUiKitFixtureHtml({ cspMeta: cspMeta() }),
    );
    expect(prepared.offlineReady).toBe(true);

    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({
        parentOrigin: window.location.origin,
      }),
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));

    const calls: Array<{ capability: string; method: string; args: unknown }> = [];
    const detach = attachBrokerBridge(["mossbot", "voice", "media", "chat", "ai", "permissions"], {
      call: (capability, method, args) => {
        calls.push({ capability, method, args });
        if (capability === "voice") {
          if (method === "startListening") return { listening: true };
          if (method === "stopListening") return { text: "请确认 UI 套件下周二前合入主干。" };
          if (method === "startRealtimeSession") return { sessionId: "rt-1" };
          if (method === "stopRealtimeSession") return { stopped: true };
          if (method === "speak") return { speaking: true };
        }
        if (capability === "mossbot") {
          if (method === "joinMeeting") return { status: "Mossbot 已加入会议" };
          if (method === "summarizeMeeting") {
            return {
              summary:
                "【会议纪要】1. 优先落地非侵入式 UI 套件；2. 确认下周二前合入主干；3. 同步生成团队路线图配图。",
            };
          }
          if (method === "askInMeeting") {
            return {
              answer: "待办：下周二前合入 Moss UI 套件主干，并同步生成路线图配图。",
            };
          }
        }
        if (capability === "media" && method === "generateImage") {
          return {
            jobId: "img-1",
            kind: "image",
            prompt: "Q4 产品路线图清爽架构示意图",
            status: "succeeded",
            url: TINY_PNG_DATA_URL,
            urls: [TINY_PNG_DATA_URL],
            dataUrls: [TINY_PNG_DATA_URL],
          };
        }
        return null;
      },
    });

    let frameLoaded = false;
    const mounted = await render(
      <iframe
        title="Meeting Room UI Kit"
        src={url}
        sandbox={pageAppIframeSandbox(true)}
        onLoad={() => {
          frameLoaded = true;
        }}
        style={{ width: "100vw", height: "100vh", border: 0, display: "block" }}
      />,
    );

    try {
      await vi.waitFor(() => expect(frameLoaded).toBe(true), { timeout: 5_000 });
      const frame = page.frameLocator(page.getByTitle("Meeting Room UI Kit"));
      await expect.element(frame.getByText("Q4 产品路线图评审会议")).toBeVisible();

      // 1. Voice dictation appends transcribed text into meeting transcript.
      const voiceBtn = frame.getByRole("button", { name: "语音速记" });
      await voiceBtn.click();
      await expect.element(frame.getByRole("button", { name: "完成录音" })).toBeVisible();
      await frame.getByRole("button", { name: "完成录音" }).click();
      await expect
        .element(frame.getByText("语音速记：请确认 UI 套件下周二前合入主干。"))
        .toBeVisible();

      // 2. Realtime voice session start.
      await frame.getByRole("button", { name: "开启实时语音" }).click();
      await expect.element(frame.getByRole("button", { name: "结束实时语音" })).toBeVisible();
      await expect.element(frame.getByText(/实时语音(已连线|中)/)).toBeVisible();

      // 3. Summon Mossbot into the meeting + generate meeting summary (including transcribed line).
      await frame.getByRole("button", { name: "拉 Moss 加入会议" }).click();
      await expect.element(frame.getByText("Mossbot 已加入会议")).toBeVisible();
      await frame.getByRole("button", { name: "生成会议纪要" }).click();
      await expect
        .element(
          frame.getByText(
            "【会议纪要】1. 优先落地非侵入式 UI 套件；2. 确认下周二前合入主干；3. 同步生成团队路线图配图。",
          ),
        )
        .toBeVisible();

      const summaryCall = calls.find(
        (c) => c.capability === "mossbot" && c.method === "summarizeMeeting",
      );
      expect(summaryCall?.args).toMatchObject({ meetingId: "room-q4-plan" });
      expect((summaryCall?.args as { transcript?: string })?.transcript).toContain(
        "请确认 UI 套件下周二前合入主干。",
      );

      // 4. Speak summary via Moss Voice TTS.
      await frame.getByRole("button", { name: "朗读纪要" }).click();
      const speakCall = calls.find((c) => c.capability === "voice" && c.method === "speak");
      expect((speakCall?.args as { text?: string })?.text).toContain("【会议纪要】");

      // 5. Generate meeting visual via MossMediaTrigger.
      await frame.getByRole("button", { name: "生成配图" }).click();
      await expect.element(frame.getByAltText("Q4 产品路线图清爽架构示意图")).toBeVisible();
      expect(calls.some((c) => c.capability === "media" && c.method === "generateImage")).toBe(
        true,
      );

      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
      await page.screenshot({
        path: `${TMP_SCREENSHOT_DIR}/ui-kit-03-smart-meeting-mossbot-voice.png`,
      });

      // 6. Ask Mossbot in meeting and verify `question` + `meetingId` contract payload.
      const askInput = frame.getByPlaceholder("向 Mossbot 提问当前会议进展或行动项…");
      await askInput.fill("当前核心行动项是什么？");
      await frame.getByRole("button", { name: "问 Mossbot" }).click();
      await expect
        .element(frame.getByText("待办：下周二前合入 Moss UI 套件主干，并同步生成路线图配图。"))
        .toBeVisible();
      const askCall = calls.find((c) => c.capability === "mossbot" && c.method === "askInMeeting");
      expect(askCall?.args).toMatchObject({
        meetingId: "room-q4-plan",
        question: "当前核心行动项是什么？",
      });
    } finally {
      detach();
      await mounted.unmount();
      URL.revokeObjectURL(url);
      await commands.endAppThumbnailRequestProbe();
    }
  });

  it("isolates Shadow DOM Core Primitives from aggressive host CSS and exports full component catalog", async () => {
    registerMossUIKit();
    expect(MOSS_UI_KIT_CATALOG.length).toBe(14);
    expect(MOSS_UI_KIT_CATALOG.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "MossButton",
        "MossCard",
        "MossTabs",
        "MossDrawer",
        "MossDialog",
        "MossBadge",
        "MossToast",
        "MossMarkdown",
        "MossVoiceButton",
        "MossRealtimeVoiceBar",
        "MossSelectionAsk",
        "MossCompanionDrawer",
        "MossbotMeetingBar",
        "MossMediaTrigger",
      ]),
    );

    const hostRoot = document.createElement("div");
    hostRoot.innerHTML = `<style>
      .host-isolated-probe button { border: 6px solid rgb(255, 0, 0) !important; background: rgb(255, 255, 0) !important; }
    </style>
    <div class="host-isolated-probe">
      <button id="host-raw-btn" type="button">Host Button</button>
    </div>`;
    document.body.appendChild(hostRoot);

    const container = hostRoot.querySelector(".host-isolated-probe") as HTMLElement;
    const headStylesBefore = document.head.querySelectorAll("style").length;

    const btn = mountButton({ container, label: "Moss 按钮", variant: "primary" });
    const card = mountCard({ container, title: "隔离卡片" });
    const md = mountMarkdown({ container: card, content: "正文 **加粗** 与 `code`" });
    const drawer = mountCompanionDrawer({ container, title: "隔离抽屉" });
    const ask = mountSelectionAsk({ target: container, drawer });

    try {
      expect(document.head.querySelectorAll("style").length).toBe(headStylesBefore);

      const hostBtnStyle = getComputedStyle(hostRoot.querySelector("#host-raw-btn")!);
      expect(hostBtnStyle.backgroundColor).toBe("rgb(255, 255, 0)");

      const innerBtn = btn.shadowRoot!.querySelector("button")!;
      expect(getComputedStyle(innerBtn).backgroundColor).toBe("rgb(20, 20, 19)");
      expect(getComputedStyle(innerBtn).borderTopColor).toBe("rgba(0, 0, 0, 0)");
      expect(md.shadowRoot!.querySelector("strong")?.textContent).toBe("加粗");
      expect(md.shadowRoot!.querySelector("code")?.textContent).toBe("code");
    } finally {
      ask.remove();
      drawer.remove();
      hostRoot.remove();
    }
  });

  it("mounts Shadow DOM UI Kit cleanly inside an opaque sandbox without allow-same-origin", async () => {
    const prepared = await commands.prepareAppLibraryFixture(
      buildMeetingRoomUiKitFixtureHtml({ cspMeta: cspMeta() }),
    );
    expect(prepared.offlineReady).toBe(true);

    const html = injectPageAppFrameRuntime(
      prepared.html,
      buildPageAppFrameRuntime({
        parentOrigin: window.location.origin,
      }),
    ).replace(
      "</body>",
      `<script type="module">
        window.parent.postMessage({
          kind: "moss-ui-kit-opaque-probe",
          origin: window.origin,
          hasSelectionAsk: Boolean(customElements.get("moss-selection-ask")),
          hasRealtimeBar: Boolean(customElements.get("moss-realtime-voice-bar")),
          hasMeetingShadow: Boolean(document.getElementById("meeting-bar")?.shadowRoot)
        }, ${JSON.stringify(window.location.origin)});
      </script></body>`,
    );
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    let probe: {
      origin: string;
      hasSelectionAsk: boolean;
      hasRealtimeBar: boolean;
      hasMeetingShadow: boolean;
    } | null = null;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as typeof probe & { kind?: string };
      if (data?.kind === "moss-ui-kit-opaque-probe") {
        probe = {
          origin: data.origin,
          hasSelectionAsk: data.hasSelectionAsk,
          hasRealtimeBar: data.hasRealtimeBar,
          hasMeetingShadow: data.hasMeetingShadow,
        };
      }
    };
    window.addEventListener("message", onMessage);

    const mounted = await render(
      <iframe
        title="Opaque UI Kit Probe"
        src={url}
        sandbox={pageAppIframeSandbox(false)}
        style={{ width: "640px", height: "480px", border: 0 }}
      />,
    );

    try {
      await vi.waitFor(() => expect(probe).not.toBeNull(), { timeout: 5_000 });
      expect(probe).toEqual({
        origin: "null",
        hasSelectionAsk: true,
        hasRealtimeBar: true,
        hasMeetingShadow: true,
      });
    } finally {
      window.removeEventListener("message", onMessage);
      await mounted.unmount();
      URL.revokeObjectURL(url);
    }
  });

  it("aligns Mossbot default meetingId, askInMeeting question field, MossDrawer --moss-radius-card, and same-origin media URLs", async () => {
    const hostWindow = window as Window & {
      moss?: { use?: (cap: string) => Promise<unknown> };
    };
    const prevMoss = hostWindow.moss;
    const mossbotCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const sameOriginAssetUrl = `${window.location.origin}/__moss_app/asset/a1?t=tok123`;

    hostWindow.moss = {
      use: async (cap: string) => {
        if (cap === "mossbot") {
          return {
            joinMeeting: async (args: Record<string, unknown>) => {
              mossbotCalls.push({ method: "joinMeeting", args });
              return { status: "Mossbot 已入场" };
            },
            summarizeMeeting: async (args: Record<string, unknown>) => {
              mossbotCalls.push({ method: "summarizeMeeting", args });
              return { summary: "默认会议 ID 纪要已生成" };
            },
            askInMeeting: async (args: Record<string, unknown>) => {
              mossbotCalls.push({ method: "askInMeeting", args });
              return { answer: "已按 question 字段收到提问" };
            },
          };
        }
        if (cap === "media") {
          return {
            generateImage: async () => ({
              url: sameOriginAssetUrl,
              urls: [sameOriginAssetUrl],
            }),
          };
        }
        throw new Error(`Capability unavailable: ${cap}`);
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const drawer = mountDrawer({ container, title: "令牌抽屉", open: true });
    const meetingBar = mountMossbotMeetingBar({
      container,
      meetingTitle: "无显式 ID 会议",
      getTranscript: () => "测试会议记录",
    });
    const mediaTrigger = mountMediaTrigger({ container, kind: "image", prompt: "架构图" });

    try {
      const drawerShell = drawer.shadowRoot!.querySelector(".drawer") as HTMLElement;
      expect(getComputedStyle(drawerShell).borderTopLeftRadius).toBe("12px");

      const joinOutcome = await meetingBar.join();
      const summaryOutcome = await meetingBar.summarize();
      const askOutcome = await meetingBar.askQuestion("确认发布节点");
      expect(joinOutcome.via).toBe("mossbot");
      expect(summaryOutcome).toEqual({ via: "mossbot", summary: "默认会议 ID 纪要已生成" });
      expect(askOutcome).toEqual({ via: "mossbot", summary: "已按 question 字段收到提问" });
      expect(mossbotCalls).toEqual([
        {
          method: "joinMeeting",
          args: { meetingId: "moss-default-meeting", title: "无显式 ID 会议" },
        },
        {
          method: "summarizeMeeting",
          args: {
            meetingId: "moss-default-meeting",
            title: "无显式 ID 会议",
            transcript: "测试会议记录",
          },
        },
        {
          method: "askInMeeting",
          args: {
            meetingId: "moss-default-meeting",
            title: "无显式 ID 会议",
            question: "确认发布节点",
            transcript: "测试会议记录",
          },
        },
      ]);

      const mediaOutcome = await mediaTrigger.trigger("架构图");
      expect(mediaOutcome).toMatchObject({
        via: "media",
        kind: "image",
        status: "ready",
        url: sameOriginAssetUrl,
      });
      const renderedImg = mediaTrigger.shadowRoot!.querySelector("img") as HTMLImageElement | null;
      expect(renderedImg?.getAttribute("src")).toBe(sameOriginAssetUrl);
    } finally {
      if (prevMoss === undefined) {
        delete hostWindow.moss;
      } else {
        hostWindow.moss = prevMoss;
      }
      container.remove();
    }
  });
});
