import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  SUPPORTED_PROVIDER_KINDS,
  ThreadId,
  type ProviderKind,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import type { MossImageJob, MossImagesCatalog } from "~/lib/mossImagesClient";
import { MossImagesError } from "~/lib/mossImagesClient";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { MossLocalizationProvider } from "~/localization";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";
import { mossServerMutationKeys, mossServerQueryKeys } from "./auth/mossServerReactQuery";
import { showContextMenuFallback } from "~/contextMenuFallback";
import { resetComposerDraftStore } from "~/composerDraftStoreTestFixtures";
import { useComposerDraftStore } from "~/composerDraftStore";
import type { MossCanvasImageFocus } from "~/lib/mossCanvasBridge";
import { PROVIDER_OPTIONS } from "~/session-logic";
import { MOSS_IMAGE_STYLES, MOSS_IMAGE_TEMPLATES } from "./images/mossImagesDiscoveryCatalog";

const providerFixture = vi.hoisted(() => ({ codexUnauthenticated: false }));

const calls = vi.hoisted(() => ({
  load: vi.fn(),
  home: vi.fn(),
  loadJob: vi.fn(),
  history: vi.fn(),
  generate: vi.fn(),
  wait: vi.fn(),
}));
// Keep the real shell, pickers, image decoding, gallery, file reader and download
// path, including the real React Query account boundary. Only media server calls
// use deterministic fixtures, so no paid generation runs during acceptance.
vi.mock("~/lib/mossImagesClient", async (original) => ({
  ...(await original<typeof import("~/lib/mossImagesClient")>()),
  loadMossImagesCatalog: calls.load,
  loadMossImagesHome: calls.home,
  loadMossImageJob: calls.loadJob,
  loadMossImagesHistory: calls.history,
  requestMossImagesGenerate: calls.generate,
  waitForMossImageJob: calls.wait,
}));

// The actual composer and picker run against deterministic CLI discovery results.
// Opening menus cannot start a provider process or a paid request in this suite.
vi.mock("~/hooks/useProviderStatusesForLocalConfig", async () => {
  const { SUPPORTED_PROVIDER_KINDS } = await import("@synara/contracts");
  return {
    useProviderStatusesForLocalConfig: () =>
      SUPPORTED_PROVIDER_KINDS.flatMap((provider) =>
        [provider, `${provider}_custom`].map((instanceId) => ({
          provider,
          instanceId,
          driver: provider,
          status: "ready",
          available: true,
          authStatus:
            provider === "codex" && providerFixture.codexUnauthenticated
              ? "unauthenticated"
              : "authenticated",
          checkedAt: "2026-10-14T00:00:00Z",
        })),
      ),
  };
});
vi.mock("~/hooks/useProviderModelCatalog", async () => {
  const { SUPPORTED_PROVIDER_KINDS } = await import("@synara/contracts");
  const { getDefaultModel } = await import("@synara/shared/model");
  const providers = [
    "codex",
    "claudeAgent",
    "cursor",
    "devin",
    "antigravity",
    "gemini",
    "grok",
    "droid",
    "kilo",
    "hermes",
    "omp",
    "opencode",
    "pi",
  ];
  const models: Record<ProviderKind, { slug: string; name: string }[]> = {
    codex: [],
    claudeAgent: [],
    cursor: [],
    devin: [],
    antigravity: [],
    gemini: [],
    grok: [],
    droid: [],
    kilo: [],
    hermes: [],
    omp: [],
    kimi: [],
    minimax: [],
    zcode: [],
    opencode: [],
    pi: [],
  };
  for (const provider of SUPPORTED_PROVIDER_KINDS) {
    models[provider] = [
      {
        slug: getDefaultModel(provider) ?? `${provider}/image-test-model`,
        name: `M12 ${provider}`,
      },
    ];
  }
  models.codex = [{ slug: "gpt-5.4", name: "GPT-5.4" }];
  models.claudeAgent = [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }];
  return {
    useProviderModelCatalog: () => ({
      modelOptionsByProvider: models,
      modelOptionsByProviderInstance: {
        ...models,
        ...Object.fromEntries(
          SUPPORTED_PROVIDER_KINDS.map((provider) => [
            `${provider}_custom`,
            [{ slug: `custom/${provider}-image-model`, name: `Custom ${provider} image model` }],
          ]),
        ),
        opencode_custom: [{ slug: "custom/image-model", name: "Custom ACP image model" }],
      },
      runtimeModelsByProvider: Object.fromEntries(providers.map((value) => [value, []])),
      selectedRuntimeModel: undefined,
      selectedRuntimeAgents: [],
      loadingModelProviders: {},
      discoveryErrorsByProvider: {},
      refreshModels: async () => {},
    }),
  };
});

import { MossImagesWorkspace } from "./MossImagesWorkspace";
import { TooltipProvider } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import type { MossImagesConversationInput } from "~/lib/mossImagesConversation";

let catalog: MossImagesCatalog;
let originalImage: string;
let editedImage: string;
let queryClient: QueryClient;

function imageFixture(color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff3bf";
  context.beginPath();
  context.arc(470, 115, 48, 0, 2 * Math.PI);
  context.fill();
  context.fillStyle = "#274e41";
  context.beginPath();
  context.moveTo(0, 480);
  context.lineTo(245, 165);
  context.lineTo(640, 480);
  context.fill();
  return canvas.toDataURL("image/png");
}

function job(overrides: Partial<MossImageJob> = {}): MossImageJob {
  return {
    jobId: "moss_landscape",
    status: "succeeded",
    prompt: "山间日出",
    createdAt: "2026-10-09T12:00:00.000Z",
    modelId: "gpt-image-2-official",
    imageUrls: [originalImage],
    billingStatus: "captured",
    billing: { creditsCharged: 12 },
    ...overrides,
  };
}

function remember(next: MossImageJob): MossImageJob {
  catalog = {
    ...catalog,
    jobs: [...catalog.jobs.filter((item) => item.jobId !== next.jobId), next],
  };
  return next;
}

async function mountWorkspace(
  onStartConversation?: (input: MossImagesConversationInput) => Promise<void>,
  withDestinationFrame = false,
  onEditInCanvas?: (image: MossCanvasImageFocus, isCurrent?: () => boolean) => void,
  settingsOverrides: Partial<typeof DEFAULT_SERVER_SETTINGS_VIEW> = {},
) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), {
    ...DEFAULT_SERVER_SETTINGS_VIEW,
    ...settingsOverrides,
  });
  queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: { user: { id: "account-a" } },
    activeRealm: "cn",
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <TooltipProvider>
            <div
              data-sidebar-layout="rail"
              style={
                {
                  height: "100vh",
                  display: "flex",
                  paddingLeft: withDestinationFrame ? 52 : 0,
                  "--app-top-strip-height": "44px",
                } as import("react").CSSProperties
              }
            >
              <div
                data-moss-destination-frame={withDestinationFrame ? "true" : undefined}
                className="flex min-h-0 min-w-0 flex-1"
              >
                <MossImagesWorkspace
                  onClose={() => undefined}
                  onStartConversation={onStartConversation}
                  {...(onEditInCanvas ? { onEditInCanvas } : {})}
                />
              </div>
            </div>
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  await expect
    .element(page.getByRole("button", { name: "Change model and reasoning" }))
    .toBeEnabled();
}

async function expectDecodedImage(source: string) {
  await vi.waitFor(() => {
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>("[data-moss-images-result] img"),
    );
    expect(
      images.some((image) => image.src === source && image.complete && image.naturalWidth === 640),
    ).toBe(true);
  });
}

const MODEL_PICKER_SOURCE_TRIGGER = /^(?:Provider|服务商): /;

// The model picker's source row opens into every provider/account it can list models for.
async function selectPickerSource(name: string | RegExp) {
  await page.getByRole("menuitem", { name: MODEL_PICKER_SOURCE_TRIGGER }).click();
  await page.getByRole("menuitemradio", { name, exact: typeof name === "string" }).click();
}

async function capture(name: string) {
  await page.screenshot({ path: `../../../../output/playwright/moss-images-${name}.png` });
}

describe("Moss Images browser workflow", () => {
  it.each(SUPPORTED_PROVIDER_KINDS)(
    "sends image intent through the real picker for %s without changing its identity",
    async (provider) => {
      const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
      await mountWorkspace(startConversation, false, undefined, {
        providers: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
          [provider]: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers[provider], enabled: true },
        },
      });
      const label = PROVIDER_OPTIONS.find((option) => option.value === provider)!.label;
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await selectPickerSource(label);
      const modelName =
        provider === "codex"
          ? "GPT-5.4"
          : provider === "claudeAgent"
            ? "Claude Sonnet 4.6"
            : `M12 ${provider}`;
      await page
        .getByRole("menuitem", {
          name: new RegExp(modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        })
        .first()
        .click();
      await userEvent.keyboard("{Escape}");
      const frame = document.querySelector("[data-moss-images-composer-frame]")!;
      expect(frame.getAttribute("data-moss-composer-provider")).toBe(provider);
      expect(frame.getAttribute("data-moss-composer-provider-instance")).toBe(provider);
      await page
        .getByRole("textbox", { name: "描述要创建的图像" })
        .fill(`用 ${provider} 创作山间日出`);
      await page.getByRole("button", { name: "生成图像", exact: true }).click();
      await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
      expect(startConversation.mock.calls[0]![0]).toMatchObject({
        prompt: `用 ${provider} 创作山间日出`,
        modelSelection: { provider, instanceId: provider },
      });
      expect(startConversation.mock.calls[0]![0]).not.toHaveProperty("modelId");
      expect(calls.generate).not.toHaveBeenCalled();
      expect(document.querySelector("[data-moss-images-result]")).toBeNull();
    },
  );

  it.each(SUPPORTED_PROVIDER_KINDS)(
    "preserves the configured %s CLI instance instead of falling back to its default account",
    async (provider) => {
      const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
      const instanceId = `${provider}_custom`;
      await mountWorkspace(startConversation, false, undefined, {
        providers: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
          [provider]: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers[provider], enabled: true },
        },
        providerInstances: {
          [instanceId]: { driver: provider, displayName: `Custom ${provider}` },
        },
      });
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      await selectPickerSource(new RegExp(`Custom ${provider}$`));
      const modelName =
        provider === "opencode" ? "Custom ACP image model" : `Custom ${provider} image model`;
      await page
        .getByRole("menuitem", { name: new RegExp(modelName) })
        .first()
        .click();
      await userEvent.keyboard("{Escape}");
      const frame = document.querySelector("[data-moss-images-composer-frame]")!;
      expect(frame.getAttribute("data-moss-composer-provider")).toBe(provider);
      expect(frame.getAttribute("data-moss-composer-provider-instance")).toBe(instanceId);
      await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("保留所选 CLI 账号创作");
      await page.getByRole("button", { name: "生成图像", exact: true }).click();
      await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
      expect(startConversation.mock.calls[0]![0]).toMatchObject({
        modelSelection: {
          provider,
          instanceId,
          model: provider === "opencode" ? "custom/image-model" : `custom/${provider}-image-model`,
        },
      });
      expect(calls.generate).not.toHaveBeenCalled();
      expect(document.querySelector("[data-moss-images-result]")).toBeNull();
    },
  );

  it("uses the chosen template ratio and custom CLI instance for one ordinary conversation", async () => {
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    await mountWorkspace(startConversation, false, undefined, {
      providerInstances: {
        opencode_custom: { driver: "opencode", displayName: "Custom ACP" },
      },
    });
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    await selectPickerSource("OpenCode · Custom ACP");
    await page
      .getByRole("menuitem", { name: /Custom ACP image model/ })
      .first()
      .click();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "预览海报" }).click();
    const dialog = page.getByRole("dialog", { name: "海报" });
    await dialog.getByRole("combobox", { name: "模板图像比例" }).click();
    await page.getByRole("option", { name: "16:9", exact: true }).click();
    await dialog.getByRole("button", { name: "试一试", exact: true }).click();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(startConversation.mock.calls[0]![0]).toMatchObject({
      prompt: `${MOSS_IMAGE_TEMPLATES[0]!.prompt}\n\n图像宽高比：16:9。`,
      modelSelection: {
        provider: "opencode",
        instanceId: "opencode_custom",
        model: "custom/image-model",
      },
    });
    expect(calls.generate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
  });

  it("explains a known unavailable CLI and prevents template dispatch without fake results", async () => {
    providerFixture.codexUnauthenticated = true;
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    await mountWorkspace(startConversation);
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("保留这次创作需求");
    await expect
      .element(page.getByRole("button", { name: "生成图像", exact: true }))
      .toBeDisabled();
    expect(document.body.textContent).toContain("not authenticated");
    await page.getByRole("button", { name: "预览海报" }).click();
    await expect.element(page.getByRole("button", { name: "试一试", exact: true })).toBeDisabled();
    expect(startConversation).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
  });

  it("applies and clears a gallery style through the existing conversation composer", async () => {
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    await mountWorkspace(startConversation);
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    await selectPickerSource("Codex");
    await page
      .getByRole("menuitem", { name: /GPT-5\.4/ })
      .first()
      .click();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("tab", { name: "热门", exact: true }).click();
    await page.getByRole("button", { name: "选择柔和水彩样式", exact: true }).click();
    await page.getByRole("button", { name: "清除样式", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "选择柔和水彩样式", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "选择几何纸艺样式", exact: true }).click();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("山间小屋");
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(startConversation.mock.calls[0]![0]).toMatchObject({
      prompt: `山间小屋\n\n${MOSS_IMAGE_STYLES[1]!.promptSuffix}`,
      modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
    });
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("keeps the legacy media account admission separate from an unauthenticated default CLI", async () => {
    providerFixture.codexUnauthenticated = true;
    await mountWorkspace();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("沿用已连接的图像模型");
    await expect.element(page.getByRole("button", { name: "生成图像", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
    expect(calls.generate.mock.calls[0]![0]).toMatchObject({
      prompt: "沿用已连接的图像模型",
      modelId: "gpt-image-2-official",
    });
  });

  it("defaults to Codex even after a Claude chat and carries an explicit CLI choice into the new conversation", async () => {
    useComposerDraftStore
      .getState()
      .setModelSelectionAndSticky(ThreadId.makeUnsafe("previous-chat"), {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      });
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    await mountWorkspace(startConversation);
    const frame = () => document.querySelector("[data-moss-images-composer-frame]")!;
    expect(frame().getAttribute("data-moss-composer-provider")).toBe("codex");
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    await selectPickerSource(/^Claude/);
    await page
      .getByRole("menuitem", { name: /Claude Sonnet 4.6/ })
      .first()
      .click();
    await userEvent.keyboard("{Escape}");
    expect(frame().getAttribute("data-moss-composer-provider")).toBe("claudeAgent");
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("生成横向 16:9 的山间日出");
    const reference = await (await fetch(originalImage)).blob();
    await page
      .getByLabelText("参考图文件")
      .upload(new File([reference], "source.png", { type: "image/png" }));
    await expect.element(page.getByRole("img", { name: "source.png", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(startConversation.mock.calls[0]?.[0]).toMatchObject({
      prompt: "生成横向 16:9 的山间日出",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      references: [expect.objectContaining({ name: "source.png" })],
    });
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("keeps the reference composition compact inside the native shell band", async () => {
    await page.viewport(2560, 1392);
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace(async () => undefined, true);
    const frame = document.querySelector("[data-moss-destination-frame]")!.getBoundingClientRect();
    const composer = document
      .querySelector("[data-moss-images-composer-frame]")!
      .getBoundingClientRect();
    const photos = document.querySelector("[data-moss-images-photos]")!.getBoundingClientRect();
    const gallery = page
      .getByRole("button", { name: "打开图像：山间日出" })
      .element()
      .getBoundingClientRect();
    expect(frame.top).toBe(44);
    expect(composer.width).toBe(768);
    expect(composer.height).toBeLessThanOrEqual(108);
    expect(composer.top).toBeGreaterThanOrEqual(124);
    expect(composer.top).toBeLessThanOrEqual(132);
    expect(photos.top - composer.bottom).toBe(32);
    expect(gallery.top).toBeGreaterThanOrEqual(575);
    expect(gallery.top).toBeLessThanOrEqual(600);
    await expect.element(page.getByRole("button", { name: "听写", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "听写", exact: true })).toBeDisabled();
    expect(document.body.textContent).not.toContain("按实际成本计入套餐用量");
    await capture("reference-frame-visual-parity-v1");
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: MODEL_PICKER_SOURCE_TRIGGER }))
      .toHaveAccessibleName(/: Codex$/);
    expect(page.getByRole("combobox", { name: "图像模型" }).elements()).toHaveLength(0);
    expect(page.getByRole("combobox", { name: "图像比例" }).elements()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("即时");
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("matches the original entry and transfers the submitted prompt into a normal conversation once", async () => {
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace(startConversation);
    const composer = document.querySelector("[data-moss-images-composer]")!;
    const photos = document.querySelector("[data-moss-images-photos]")!;
    expect(composer.getBoundingClientRect().bottom).toBeLessThan(
      photos.getBoundingClientRect().top,
    );
    await expect.element(page.getByRole("button", { name: "上传照片" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "打开资料库" })).toBeVisible();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("无人机视角");
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    expect(startConversation.mock.calls[0]?.[0]).toMatchObject({
      prompt: "无人机视角",
      modelSelection: expect.objectContaining({ provider: "codex", instanceId: "codex" }),
    });
    expect(calls.generate).not.toHaveBeenCalled();
    expect(startConversation.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
    expect(calls.load).not.toHaveBeenCalled();
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
    await capture("original-entry-conversation");
  });
  it("sends the selected historical image and local references through the ordinary CLI once", async () => {
    let finishStart!: () => void;
    const startConversation = vi.fn(
      (_input: MossImagesConversationInput) =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    catalog = { ...catalog, jobs: [job({ imageUrls: [originalImage, editedImage] })] };
    const originalFetch = globalThis.fetch.bind(globalThis);
    const imageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(originalFetch);
    const expectedOriginal = await (await originalFetch(editedImage)).blob();
    const localReference = new File(
      [await (await originalFetch(originalImage)).blob()],
      "extra.png",
      {
        type: "image/png",
      },
    );
    await mountWorkspace(startConversation);
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByTestId("generated-image-preview-view-playground").click();
    await page.getByTestId("generated-image-playground-image-moss_landscape:1").click();
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("把选中的图改成夜景");
    await page.getByLabelText("参考图文件").upload(localReference);
    await expect.element(page.getByRole("button", { name: "移除 extra.png" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "编辑图像", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    document.querySelector<HTMLFormElement>("[data-moss-images-composer-frame]")!.requestSubmit();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    const input = startConversation.mock.calls[0]![0];
    expect(input).toMatchObject({
      prompt: "把选中的图改成夜景",
      modelSelection: expect.objectContaining({ provider: "codex", instanceId: "codex" }),
      references: [
        expect.objectContaining({ name: "moss-moss_landscape-2.png", type: "image/png" }),
        expect.objectContaining({ name: "extra.png", type: "image/png" }),
      ],
    });
    expect(input.references[0]).toBeInstanceOf(File);
    expect(await input.references[0]!.arrayBuffer()).toEqual(await expectedOriginal.arrayBuffer());
    expect(await input.references[1]!.arrayBuffer()).toEqual(await localReference.arrayBuffer());
    expect(imageFetch).toHaveBeenCalledExactlyOnceWith(editedImage, { credentials: "omit" });
    expect(input).not.toHaveProperty("modelId");
    expect(input.isCurrent()).toBe(true);
    expect(document.body.textContent).not.toContain("请选择支持参考图的模型");
    expect(calls.load).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
    finishStart();
  });
  it("keeps a wide image preview clickable when external Canvas navigation does not replace it", async () => {
    await page.viewport(1280, 900);
    const edit = vi.fn((_image: MossCanvasImageFocus, _isCurrent?: () => boolean) => undefined);
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace(async () => undefined, false, edit);
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    const pane = document.querySelector<HTMLElement>(
      '[data-testid="generated-image-preview-pane"]',
    )!;
    await vi.waitFor(() => {
      expect(pane.getBoundingClientRect().width).toBeGreaterThan(480);
      const image = pane.querySelector<HTMLImageElement>("img[data-image-id]")!;
      expect(image.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(image.getBoundingClientRect().height).toBeGreaterThan(0);
    });
    // A failed or cancelled destination leaves this same controlled preview mounted.
    const canvas = page.getByRole("button", { name: "画布视图", exact: true });
    await canvas.click();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(pane.dataset.generatedImagePreviewView).toBe("single");
    await expect.element(canvas).toBeEnabled();
    await canvas.click();
    expect(edit).toHaveBeenCalledTimes(2);
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("invalidates an original Canvas lookup when the selected historical image changes", async () => {
    const edit = vi.fn((_image: MossCanvasImageFocus, _isCurrent?: () => boolean) => undefined);
    catalog = { ...catalog, jobs: [job({ imageUrls: [originalImage, editedImage] })] };
    await mountWorkspace(async () => undefined, false, edit);
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("button", { name: "编辑图像", exact: true }).first().click();
    expect(edit).toHaveBeenCalledTimes(1);
    const isCurrent = edit.mock.calls[0]![1]!;
    expect(isCurrent()).toBe(true);
    await page.getByTestId("generated-image-preview-rail-tile-moss_landscape:1").click();
    await vi.waitFor(() => expect(isCurrent()).toBe(false));
    expect(calls.generate).not.toHaveBeenCalled();
  });
  it("reads a cached historical image with local credentials and keeps its handoff valid after unmount", async () => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const png = await (await originalFetch(originalImage)).blob();
    const downloadPath = "/api/moss/media/assets/moss_landscape/0";
    const downloadUrl = new URL(downloadPath, window.location.origin).toString();
    const imageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) =>
        url === downloadUrl ? new Response(png) : originalFetch(url, init),
      );
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    catalog = {
      ...catalog,
      jobs: [
        job({
          assets: [
            {
              assetId: "asset-original",
              kind: "image",
              index: 0,
              contentType: "image/png",
              byteLength: png.size,
              downloadPath,
            },
          ],
        }),
      ],
    };
    await mountWorkspace(startConversation);
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("编辑本机保存的原图");
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    await vi.waitFor(() => expect(startConversation).toHaveBeenCalledTimes(1));
    const input = startConversation.mock.calls[0]![0];
    expect(imageFetch).toHaveBeenCalledExactlyOnceWith(downloadUrl, { credentials: "include" });
    expect(await input.references[0]!.arrayBuffer()).toEqual(await png.arrayBuffer());
    await cleanup();
    expect(input.isCurrent()).toBe(true);
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.load).not.toHaveBeenCalled();
  });
  it.each(["close", "account", "selected-image"] as const)(
    "rejects a late historical image read after %s changes its owner",
    async (change) => {
      let finishRead!: () => void;
      const originalFetch = globalThis.fetch.bind(globalThis);
      const imageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (url === originalImage)
          await new Promise<void>((resolve) => {
            finishRead = resolve;
          });
        return originalFetch(url, init);
      });
      const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
      catalog = { ...catalog, jobs: [job({ imageUrls: [originalImage, editedImage] })] };
      await mountWorkspace(startConversation);
      await page.getByRole("button", { name: "打开图像：山间日出" }).click();
      await page.getByTestId("generated-image-preview-view-playground").click();
      await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("账号 A 的修改");
      await expect
        .element(page.getByRole("button", { name: "编辑图像", exact: true }))
        .toBeEnabled();
      await page.getByRole("button", { name: "编辑图像", exact: true }).click();
      await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
      if (change === "close") await page.getByRole("button", { name: "Close 山间日出" }).click();
      else if (change === "selected-image") {
        await page.getByTestId("generated-image-playground-image-moss_landscape:1").click();
        // Returning to the original image must not revive an obsolete read.
        await page.getByTestId("generated-image-playground-image-moss_landscape:0").click();
      } else {
        catalog = { ...catalog, account: { id: "account-b", realm: "memfire-phone" }, jobs: [] };
        queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
          authenticated: true,
          session: { user: { id: "account-b" } },
          activeRealm: "cn",
        });
        await expect.element(page.getByRole("textbox", { name: "描述要创建的图像" })).toBeVisible();
      }
      finishRead();
      await vi.waitFor(() => expect(imageFetch.mock.settledResults.at(-1)?.type).toBe("fulfilled"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(startConversation).not.toHaveBeenCalled();
      expect(calls.generate).not.toHaveBeenCalled();
      expect(calls.load).not.toHaveBeenCalled();
      if (change === "selected-image")
        await expect
          .element(page.getByRole("button", { name: "编辑图像", exact: true }))
          .toBeEnabled();
      else expect(document.body.textContent).not.toContain("账号 A 的修改");
    },
  );
  it("keeps the historical edit draft when its image cannot be read", async () => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
      url === originalImage ? new Response(null, { status: 503 }) : originalFetch(url, init),
    );
    const startConversation = vi.fn(async (_input: MossImagesConversationInput) => undefined);
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace(startConversation);
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("读取失败时保留描述");
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("暂时无法连接图像服务");
    await expect
      .element(page.getByRole("textbox", { name: "描述要如何修改当前图像" }))
      .toHaveTextContent("读取失败时保留描述");
    await expect.element(page.getByRole("button", { name: "编辑图像", exact: true })).toBeEnabled();
    expect(startConversation).not.toHaveBeenCalled();
    expect(calls.generate).not.toHaveBeenCalled();
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    providerFixture.codexUnauthenticated = false;
    resetComposerDraftStore();
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    localStorage.setItem("has-dismissed-image-canvas-view-coachmark-v1", "true");
    originalImage = imageFixture("#b7dbe8");
    editedImage = imageFixture("#b7a4d9");
    catalog = {
      account: { id: "account-a", realm: "memfire-phone", creditBalance: 240 },
      models: [
        {
          id: "gpt-image-2-official",
          label: "GPT Image",
          kind: "image",
          installed: true,
          available: true,
          supportsReferences: true,
        },
      ],
      jobs: [],
    };
    calls.load.mockImplementation(async () => catalog);
    calls.home.mockImplementation(async () => ({
      ...catalog,
      models: [],
      nextCursor: catalog.nextCursor ?? null,
    }));
    calls.generate.mockImplementation(async () => remember(job()));
    calls.loadJob.mockImplementation(async () => remember(job()));
    calls.wait.mockImplementation(async ({ job: current }: { job: MossImageJob }) => current);
    calls.history.mockImplementation(async () => ({
      account: catalog.account,
      jobs: [],
      nextCursor: null,
    }));
    await page.viewport(1280, 900);
  });

  afterEach(async () => {
    await cleanup();
    await queryClient?.cancelQueries();
    queryClient?.clear();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("restores a conversation across pages and branches the next edit from the selected old image", async () => {
    const conversationId = `mossconv_${"a".repeat(32)}`;
    const first = job({ jobId: "moss_first", prompt: "第一轮", conversationId, parentJobId: null });
    const second = job({
      jobId: "moss_second",
      prompt: "第二轮",
      conversationId,
      parentJobId: first.jobId,
      imageUrls: [editedImage],
    });
    const third = job({
      jobId: "moss_third",
      prompt: "第三轮",
      conversationId,
      parentJobId: second.jobId,
      imageUrls: [imageFixture("#da9966")],
    });
    catalog = { ...catalog, jobs: [third], nextCursor: null };
    calls.history.mockImplementation(
      async (input: { conversationId?: string; cursor?: string }) => ({
        account: catalog.account,
        conversationId,
        kind: "image",
        jobs: !input.conversationId ? [third] : input.cursor ? [first] : [third, second],
        nextCursor: input.conversationId && !input.cursor ? "earlier" : null,
      }),
    );
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：第三轮" }).click();
    await expect.element(page.getByRole("button", { name: "加载更早的图像" })).toBeEnabled();
    await page.getByRole("button", { name: "加载更早的图像" }).click();
    await page.getByTestId("generated-image-preview-view-playground").click();
    for (const entry of [first, second, third])
      await expect
        .element(page.getByTestId(`generated-image-playground-image-${entry.jobId}:0`))
        .toBeVisible();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.loadJob).not.toHaveBeenCalled();
    expect(calls.wait).not.toHaveBeenCalled();
    await capture("conversation-restored");
    await page.getByTestId("generated-image-playground-image-moss_first:0").click();
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("从第一张继续");
    calls.generate.mockImplementationOnce(async () =>
      remember(
        job({
          jobId: "moss_branch",
          prompt: "从第一张继续",
          conversationId,
          parentJobId: first.jobId,
          imageUrls: [editedImage],
        }),
      ),
    );
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
    expect(calls.generate.mock.calls[0]?.[0]).toMatchObject({
      conversationId,
      parentJobId: first.jobId,
      referenceImages: [originalImage],
    });
    expect(
      calls.history.mock.calls.some(
        ([input]) => input.cursor === "earlier" && input.conversationId === conversationId,
      ),
    ).toBe(true);
    await expect.element(page.getByRole("button", { name: "图像", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "图像", exact: true }).click();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("新一轮独立图像");
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(2));
    expect(calls.generate.mock.calls[1]?.[0]).not.toHaveProperty("conversationId");
    expect(calls.generate.mock.calls[1]?.[0]).not.toHaveProperty("parentJobId");
  });

  it("retries a failed local history page without duplicating rows or sending generation", async () => {
    const conversationId = `mossconv_${"b".repeat(32)}`;
    const newer = job({ conversationId, parentJobId: null });
    const older = job({
      jobId: "moss_older",
      prompt: "较早图像",
      conversationId,
      parentJobId: null,
    });
    catalog = { ...catalog, jobs: [newer], nextCursor: "mixed-catalog-cursor" };
    calls.history
      .mockResolvedValueOnce({
        account: catalog.account,
        jobs: [newer],
        nextCursor: "images-page-2",
      })
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({ account: catalog.account, jobs: [newer, older], nextCursor: null });
    await mountWorkspace();
    await page.getByRole("button", { name: "加载更多图像" }).click();
    await page.getByRole("button", { name: "重试读取记录" }).click();
    await expect.element(page.getByRole("button", { name: "打开图像：较早图像" })).toBeVisible();
    expect(page.getByRole("button", { name: "打开图像：山间日出" }).elements()).toHaveLength(1);
    expect(calls.history.mock.calls.slice(1).map(([input]) => input.cursor)).toEqual([
      "images-page-2",
      "images-page-2",
    ]);
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.loadJob).not.toHaveBeenCalled();
  });

  it("clears old history when the server reports an account change before the account hook updates", async () => {
    const conversationId = `mossconv_${"e".repeat(32)}`;
    catalog = { ...catalog, jobs: [job({ conversationId, parentJobId: null })] };
    calls.history.mockRejectedValueOnce(
      new MossImagesError("account changed", "media_account_changed", 409),
    );
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await expect.element(page.getByRole("textbox", { name: "描述要创建的图像" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "打开图像：山间日出" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "生成图像", exact: true }))
      .toBeDisabled();
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("keeps the newest task revision when a previously requested history page arrives late", async () => {
    const conversationId = `mossconv_${"d".repeat(32)}`;
    const completed = job({ conversationId, parentJobId: null, revision: 5 });
    catalog = { ...catalog, jobs: [], nextCursor: null };
    let finish!: (value: unknown) => void;
    calls.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    calls.generate.mockImplementationOnce(async () => remember(completed));
    await mountWorkspace();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("山间日出");
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await expectDecodedImage(originalImage);
    finish({
      account: catalog.account,
      jobs: [
        { ...completed, revision: 2, status: "running", imageUrls: [], billingStatus: "pending" },
      ],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(calls.load).toHaveBeenCalledTimes(2));
    await page.getByRole("button", { name: "图像", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "打开图像：山间日出" }))
      .toHaveTextContent("已生成");
    expect(calls.generate).toHaveBeenCalledTimes(1);
    expect(calls.loadJob).not.toHaveBeenCalled();
  });

  it("discards a late conversation after switching realm even when the user id stays the same", async () => {
    const conversationId = `mossconv_${"c".repeat(32)}`;
    const original = job({ conversationId, parentJobId: null });
    catalog = { ...catalog, jobs: [original] };
    let finish!: (value: unknown) => void;
    calls.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const oldAccount = catalog.account;
    catalog = { ...catalog, account: { id: "account-a", realm: "supabase-global" }, jobs: [] };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "account-a" } },
      activeRealm: "global",
    });
    await expect.element(page.getByRole("textbox", { name: "描述要创建的图像" })).toBeVisible();
    finish({
      account: oldAccount,
      conversationId,
      kind: "image",
      jobs: [original],
      nextCursor: null,
    });
    await vi.waitFor(() => expect(calls.history.mock.results[0]?.type).toBe("return"));
    await expect
      .element(page.getByRole("button", { name: "打开图像：山间日出" }))
      .not.toBeInTheDocument();
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
    expect(calls.generate).not.toHaveBeenCalled();
    expect(calls.loadJob).not.toHaveBeenCalled();
  });

  it.each([
    ["正方形", "1:1"],
    ["竖版", "3:4"],
    ["故事", "9:16"],
    ["横版", "4:3"],
    ["宽屏", "16:9"],
  ])(
    "resizes the selected original with the %s edit action and preserves the composer draft",
    async (label, ratio) => {
      catalog = { ...catalog, jobs: [job()] };
      await mountWorkspace();
      await page.getByRole("button", { name: "打开图像：山间日出" }).click();
      await page
        .getByRole("textbox", { name: "描述要如何修改当前图像" })
        .fill("保留这段未提交的文字");
      const reference = await (await fetch(editedImage)).blob();
      await page
        .getByLabelText("参考图文件")
        .upload(new File([reference], "next-edit.png", { type: "image/png" }));
      await expect.element(page.getByRole("button", { name: "移除 next-edit.png" })).toBeVisible();
      await page.getByRole("button", { name: "调整比例", exact: true }).click();
      expect(calls.generate).not.toHaveBeenCalled();
      await page.getByRole("menuitem", { name: `${label} ${ratio}` }).click();
      await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
      expect(calls.generate.mock.calls[0]?.[0]).toEqual({
        prompt: `将这张图像的宽高比调整为 ${ratio}`,
        modelId: "gpt-image-2-official",
        aspectRatio: ratio,
        referenceImages: [originalImage],
        idempotencyKey: expect.any(String),
        expectedAccount: { id: "account-a", realm: "memfire-phone" },
      });
      await expect
        .element(page.getByRole("textbox", { name: "描述要如何修改当前图像" }))
        .toHaveTextContent("保留这段未提交的文字");
      await expect.element(page.getByRole("button", { name: "移除 next-edit.png" })).toBeVisible();
    },
  );

  it("cancels the resize menu without submitting and disables it for a model without image inputs", async () => {
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("button", { name: "调整比例", exact: true }).click();
    await page.getByRole("menuitem", { name: "宽屏 16:9" }).elements()[0]!.focus();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await expect.element(page.getByRole("menuitem", { name: "宽屏 16:9" })).not.toBeInTheDocument();
    expect(calls.generate).not.toHaveBeenCalled();
    catalog = {
      ...catalog,
      models: catalog.models.map((entry) => ({ ...entry, supportsReferences: false })),
    };
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "调整比例", exact: true }))
      .toBeDisabled();
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("abandons a resize waiting for its account-owned original when the account changes", async () => {
    const bytes = await (await fetch(originalImage)).blob();
    const downloadPath = "/api/moss/media/assets/moss_landscape/0";
    catalog = {
      ...catalog,
      jobs: [
        job({
          assets: [
            {
              assetId: "moss_landscape:0",
              kind: "image",
              index: 0,
              contentType: "image/png",
              byteLength: bytes.size,
              downloadPath,
            },
          ],
        }),
      ],
    };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    let release!: (response: Response) => void;
    let assetSignal: AbortSignal | undefined;
    const actualFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).endsWith(downloadPath)) {
        expect(init?.credentials).toBe("include");
        assetSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return actualFetch(input, init);
    });
    await page.getByRole("button", { name: "调整比例", exact: true }).click();
    await page.getByRole("menuitem", { name: "宽屏 16:9" }).click();
    await vi.waitFor(() => expect(assetSignal).toBeDefined());
    expect(calls.generate).not.toHaveBeenCalled();
    catalog = {
      ...catalog,
      account: { id: "account-b", realm: "memfire-phone", creditBalance: 10 },
      jobs: [],
    };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "account-b" } },
      activeRealm: "cn",
    });
    await vi.waitFor(() => expect(assetSignal?.aborted).toBe(true));
    release(new Response(bytes, { headers: { "content-type": "image/png" } }));
    await expect
      .element(page.getByRole("textbox", { name: "描述要创建的图像" }))
      .toHaveTextContent(/^$/);
    expect(calls.generate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
  });

  it("prepares marked pixels and comments for the composer, submits only on send, and preserves the original", async () => {
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("button", { name: "标注", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "标注图像" })).toBeVisible();
    await page.getByRole("button", { name: "评论", exact: true }).click();
    await page.getByRole("textbox", { name: "评论内容" }).fill("把山峰改成蓝色");
    await page.getByRole("img", { name: "图像标注画布" }).click();
    await page.getByRole("button", { name: "完成标注" }).click();
    await expect.element(page.getByRole("img", { name: "标注预览", exact: true })).toBeVisible();
    expect(calls.generate).not.toHaveBeenCalled();
    const previewSource = (
      page.getByRole("img", { name: "标注预览", exact: true }).elements()[0] as HTMLImageElement
    ).src;
    expect(previewSource).not.toBe(originalImage);
    const bitmap = await createImageBitmap(await (await fetch(previewSource)).blob());
    expect([bitmap.width, bitmap.height]).toEqual([640, 480]);
    bitmap.close();
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    expect(calls.generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "1. (x: 50.0%, y: 50.0%) 把山峰改成蓝色",
      referenceImages: [previewSource],
      expectedAccount: { id: "account-a", realm: "memfire-phone" },
    });
    expect(catalog.jobs[0]?.imageUrls).toEqual([originalImage]);
    await expect
      .element(page.getByRole("img", { name: "标注预览", exact: true }))
      .not.toBeInTheDocument();
  });

  it("discards markup with its owning account and never sends it from the next account", async () => {
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("button", { name: "标注", exact: true }).click();
    await page.getByRole("img", { name: "图像标注画布" }).click();
    await page.getByRole("button", { name: "完成标注" }).click();
    await expect.element(page.getByRole("img", { name: "标注预览", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "修改标注", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "标注图像" })).toBeVisible();
    catalog = {
      ...catalog,
      account: { id: "account-b", realm: "memfire-phone", creditBalance: 10 },
      jobs: [],
    };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "account-b" } },
      activeRealm: "cn",
    });
    await expect
      .element(page.getByRole("textbox", { name: "描述要创建的图像" }))
      .toHaveTextContent(/^$/);
    expect(page.getByRole("dialog", { name: "标注图像" }).elements()).toHaveLength(0);
    expect(page.getByRole("img", { name: "标注预览", exact: true }).elements()).toHaveLength(0);
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("submits an actual alpha mask with the same-size original through the account-bound edit pipeline", async () => {
    catalog = {
      ...catalog,
      jobs: [job()],
      models: catalog.models.map((entry) => ({ ...entry, supportsMaskEdits: true })),
    };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("保留的文字草稿");
    await page.getByRole("button", { name: "擦除", exact: true }).click();
    await page.getByRole("img", { name: "擦除选区画布" }).click();
    expect(calls.generate).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "移除选区" }).click();
    // Native PNG encoding and file reads are asynchronous on slower CI workers.
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce(), { timeout: 5000 });
    const request = calls.generate.mock.calls[0]![0];
    expect(request).toMatchObject({
      prompt: "移除此图像中选定的区域。",
      aspectRatio: "auto",
      outputFormat: "png",
      expectedAccount: { id: "account-a", realm: "memfire-phone" },
      idempotencyKey: expect.any(String),
    });
    expect(request.referenceImages).toHaveLength(1);
    expect(request.referenceImages[0]).toMatch(/^data:image\/png;base64,/);
    const mask = await createImageBitmap(await (await fetch(request.maskImage)).blob());
    const source = await createImageBitmap(await (await fetch(request.referenceImages[0])).blob());
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(mask, 0, 0);
    expect([mask.width, mask.height, source.width, source.height]).toEqual([640, 480, 640, 480]);
    expect(context.getImageData(320, 240, 1, 1).data[3]).toBe(0);
    expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(255);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0);
    expect(context.getImageData(320, 240, 1, 1).data[3]).toBe(255);
    mask.close();
    source.close();
    expect(catalog.jobs[0]!.imageUrls).toEqual([originalImage]);
    await expect
      .element(page.getByRole("dialog", { name: "擦除图像内容" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "描述要如何修改当前图像" }))
      .toHaveTextContent("保留的文字草稿");
  });

  it("requires explicit edit capabilities and sends transparent background without mutating the source", async () => {
    catalog = { ...catalog, jobs: [job()] };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await expect.element(page.getByRole("button", { name: "擦除", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "移除背景", exact: true }))
      .toBeDisabled();
    expect(document.querySelector('[title="此模型未提供选区擦除能力"]')).not.toBeNull();
    expect(calls.generate).not.toHaveBeenCalled();
    catalog = {
      ...catalog,
      models: catalog.models.map((entry) => ({ ...entry, supportsTransparentBackground: true })),
    };
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "移除背景", exact: true })).toBeEnabled();
    await expect.element(page.getByRole("button", { name: "擦除", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "移除背景", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    expect(calls.generate.mock.calls[0]![0]).toMatchObject({
      referenceImages: [originalImage],
      aspectRatio: "auto",
      background: "transparent",
      outputFormat: "png",
      prompt: expect.stringContaining("保持所有前景主体完整且不变"),
      expectedAccount: { id: "account-a", realm: "memfire-phone" },
    });
    expect(calls.generate.mock.calls[0]![0].maskImage).toBeUndefined();
    expect(catalog.jobs[0]!.imageUrls).toEqual([originalImage]);
  });

  it("drops an erase export that finishes after its account changes, without any generation", async () => {
    catalog = {
      ...catalog,
      jobs: [job()],
      models: catalog.models.map((entry) => ({ ...entry, supportsMaskEdits: true })),
    };
    await mountWorkspace();
    await page.getByRole("button", { name: "打开图像：山间日出" }).click();
    await page.getByRole("button", { name: "擦除", exact: true }).click();
    await page.getByRole("img", { name: "擦除选区画布" }).click();
    const pending: BlobCallback[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      pending.push(callback);
    });
    await page.getByRole("button", { name: "移除选区" }).click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    catalog = {
      ...catalog,
      account: { id: "account-b", realm: "memfire-phone", creditBalance: 5 },
      jobs: [],
    };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "account-b" } },
      activeRealm: "cn",
    });
    await expect
      .element(page.getByRole("dialog", { name: "擦除图像内容" }))
      .not.toBeInTheDocument();
    const image = await (await fetch(originalImage)).blob();
    pending.forEach((callback) => callback(image));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it("keeps the entry composer above the photo row while browsing, accepts drop/paste and reuses a generated reference", async () => {
    catalog = {
      ...catalog,
      jobs: Array.from({ length: 16 }, (_, index) =>
        job({ jobId: `moss_gallery_${index}`, prompt: `日出构图 ${index + 1}` }),
      ),
      mediaWallet: {
        walletKind: "media_cost_v1",
        currency: "CNY",
        pointsPerCny: 100,
        availableNanoCny: "12345678901",
        heldNanoCny: "1",
      },
    };
    await mountWorkspace();
    const composer = document.querySelector<HTMLTextAreaElement>("[data-moss-images-composer]")!;
    const gallery = document.querySelector<HTMLElement>("[data-moss-images-gallery]")!;
    const before = composer.getBoundingClientRect().top;
    gallery.scrollTop = gallery.scrollHeight;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(gallery.scrollTop).toBeGreaterThan(100);
    expect(composer.getBoundingClientRect().top).toBeLessThan(before);
    gallery.scrollTop = 0;
    await expect.element(page.getByText(/媒体积分/)).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "打开资料库" })).toBeVisible();
    const blob = await (await fetch(originalImage)).blob();
    const drop = new DataTransfer();
    drop.items.add(new File([blob], "dropped.png", { type: "image/png" }));
    document
      .querySelector("[data-moss-images-workspace]")!
      .dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: drop }),
      );
    await expect.element(page.getByRole("button", { name: "移除 dropped.png" })).toBeVisible();
    const paste = new DataTransfer();
    paste.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    composer.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: paste }),
    );
    await expect.element(page.getByRole("button", { name: "移除 pasted.png" })).toBeVisible();
    await page.getByRole("button", { name: "使用“日出构图 1”作参考图", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "移除 moss-moss_gallery_0-1.png" }))
      .toBeVisible();
    await capture("fixed-composer-references-media-balance");
    gallery.scrollTop = 0;
    expect(calls.generate).not.toHaveBeenCalled();
    await page.viewport(390, 844);
    await expect.element(page.getByRole("button", { name: "生成图像", exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391);
    await capture("mobile-fixed-composer");
  });

  it("runs image context actions through the owning Images tab and copies decoded PNG bytes", async () => {
    const previousNativeApi = window.nativeApi;
    const contextMenu = { show: showContextMenuFallback };
    const showContextMenu = vi.spyOn(contextMenu, "show");
    window.nativeApi = { contextMenu } as NonNullable<typeof window.nativeApi>;
    const copied: ClipboardItem[][] = [];
    const actionToast = vi.spyOn(toastManager, "add");
    // Observe the real browser pipeline so a CI failure identifies whether the
    // menu, image fetch, decode or encoding failed without replacing those steps.
    const imageFetch = vi.spyOn(globalThis, "fetch");
    const imageDecode = vi.spyOn(globalThis, "createImageBitmap");
    const encodedPngTypes: Array<string | null> = [];
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    const pngEncode = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
        originalToBlob.call(
          this,
          (blob) => {
            encodedPngTypes.push(blob?.type ?? null);
            callback(blob);
          },
          type,
          quality,
        );
      });
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      copied.push(items);
    });
    catalog = {
      ...catalog,
      jobs: [
        job({
          billing: {
            walletKind: "media_cost_v1",
            chargedNanoCny: "1",
            creditsCharged: 0,
            actualCostNano: 1,
            currency: "CNY",
            fxVersion: "cny-direct-v1",
          },
        }),
      ],
    };
    try {
      await mountWorkspace();
      await page.getByRole("button", { name: "打开图像：山间日出", exact: true }).click();
      await expectDecodedImage(originalImage);
      await expect.element(page.getByText("历史费用 ¥0.000000001", { exact: true })).toBeVisible();
      const openMenu = () => {
        document.querySelector('[data-testid="generated-image-preview-scroll"] img')!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 620,
            clientY: 280,
          }),
        );
      };
      openMenu();
      await expect
        .element(page.getByRole("button", { name: "复制图片", exact: true }))
        .toBeVisible();
      await capture("generated-image-context-menu");
      await page.getByRole("button", { name: "复制图片", exact: true }).click();
      await vi.waitFor(() => {
        expect(actionToast).not.toHaveBeenCalled();
        expect(showContextMenu.mock.settledResults[0]).toEqual({
          type: "fulfilled",
          value: "copy-image",
        });
        expect(
          copied,
          JSON.stringify({
            desktopClipboard: typeof window.desktopBridge?.clipboard?.writeImagePngDataUrl,
            imageFetches: imageFetch.mock.calls.filter(([url]) => url === originalImage).length,
            fetchResults: imageFetch.mock.settledResults.map(({ type }) => type),
            decodeResults: imageDecode.mock.settledResults.map(({ type }) => type),
            pngEncodes: pngEncode.mock.calls.length,
            encodedPngTypes,
          }),
        ).toHaveLength(1);
      });
      const png = await copied[0]![0]!.getType("image/png");
      expect(png.type).toBe("image/png");
      expect(png.size).toBeGreaterThan(100);
      openMenu();
      await page.getByRole("button", { name: "在新图像标签打开", exact: true }).click();
      await vi.waitFor(() =>
        expect(
          document
            .querySelector("[data-moss-images-workspace]")
            ?.getAttribute("data-moss-images-tab-count"),
        ).toBe("2"),
      );
      await expectDecodedImage(originalImage);
      openMenu();
      await page.getByRole("button", { name: "用作参考图", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "移除 moss-moss_landscape-1.png", exact: true }))
        .toBeVisible();
      await expect.element(page.getByRole("textbox", { name: "描述要创建的图像" })).toBeVisible();
      expect(calls.generate).not.toHaveBeenCalled();
      await capture("context-reference-new-tab");
    } finally {
      if (previousNativeApi) window.nativeApi = previousNativeApi;
      else delete window.nativeApi;
    }
  });

  it("retains references, edits a result, switches Focused/Canvas and downloads the active image", async () => {
    await mountWorkspace();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("山间日出");
    const reference = await (await fetch(originalImage)).blob();
    await page
      .getByLabelText("参考图文件")
      .upload(new File([reference], "landscape.png", { type: "image/png" }));
    await expect
      .element(page.getByRole("img", { name: "landscape.png", exact: true }))
      .toBeVisible();
    await capture("prompt-tabs-reference");
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await expectDecodedImage(originalImage);
    expect(calls.generate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        prompt: "山间日出",
        aspectRatio: "1:1",
        referenceImages: [originalImage],
        expectedAccount: { id: "account-a", realm: "memfire-phone" },
      }),
      expect.any(AbortSignal),
    );
    await expect.element(page.getByText("扣除 12 体验积分", { exact: true })).toBeVisible();
    await capture("focused");

    calls.generate.mockImplementationOnce(async () =>
      remember(
        job({
          jobId: "moss_edited",
          prompt: "把天空改成紫色",
          imageUrls: [editedImage],
        }),
      ),
    );
    await page.getByRole("textbox", { name: "描述要如何修改当前图像" }).fill("把天空改成紫色");
    await page.getByRole("button", { name: "编辑图像", exact: true }).click();
    await expectDecodedImage(editedImage);
    expect(calls.generate.mock.calls[1]?.[0]).toMatchObject({
      prompt: "把天空改成紫色",
      referenceImages: [originalImage],
    });
    await page.getByTestId("generated-image-preview-view-playground").click();
    await expect.element(page.getByTestId("generated-image-playground")).toBeVisible();
    await expect
      .element(page.getByTestId("generated-image-playground-image-moss_landscape:0"))
      .toBeVisible();
    await expect
      .element(page.getByTestId("generated-image-playground-image-moss_edited:0"))
      .toBeVisible();
    await capture("canvas-edit-history");
    await page.getByTestId("generated-image-preview-view-single").click();
    await expect
      .element(page.getByTestId("generated-image-preview-view-single"))
      .toHaveAttribute("aria-pressed", "true");

    // Observe the actual Blob handed to an unmodified browser download anchor.
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const downloads: { href: string; name: string }[] = [];
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof HTMLAnchorElement && event.target.download) {
        downloads.push({ href: event.target.href, name: event.target.download });
      }
    };
    document.addEventListener("click", onClick);
    try {
      await page.getByTestId("generated-image-preview-download").click();
      await vi.waitFor(() =>
        expect(
          downloads.some(
            (download) =>
              download.href.startsWith("blob:") && download.name === "moss-moss_edited-1.png",
          ),
        ).toBe(true),
      );
      const blob = createObjectURL.mock.calls[0]?.[0];
      expect(blob).toBeInstanceOf(Blob);
      expect((blob as Blob).type).toBe("image/png");
      expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(
        new Uint8Array(await (await fetch(editedImage)).arrayBuffer()),
      );
    } finally {
      document.removeEventListener("click", onClick);
    }
    expect(page.getByRole("img", { name: "landscape.png", exact: true }).elements()).toHaveLength(
      0,
    );
  });

  it.each([
    { status: "reconciliation_required", billingStatus: "unknown" },
    { status: "succeeded", billingStatus: "unknown" },
    { status: "succeeded", billingStatus: "pending" },
  ] as const)(
    "reconciles $status/$billingStatus on the original task without submitting again",
    async ({ status, billingStatus }) => {
      const unresolved = job({
        status,
        imageUrls: status === "succeeded" ? [originalImage] : [],
        billingStatus,
        billing: {},
      });
      catalog = {
        ...catalog,
        jobs: [unresolved],
        mediaWallet: {
          walletKind: "media_cost_v1",
          currency: "CNY",
          pointsPerCny: 100,
          availableNanoCny: "1000000000",
          heldNanoCny: "1",
          reviewRequired: true,
        },
      };
      await mountWorkspace();
      await page.getByRole("button", { name: "打开图像：山间日出" }).click();
      await expect.element(page.getByRole("button", { name: "检查任务与费用" })).toBeVisible();
      if (status === "succeeded") await expectDecodedImage(originalImage);
      await capture(`reconciliation-${status}-${billingStatus}`);
      await page.getByRole("button", { name: "检查任务与费用" }).click();
      await expectDecodedImage(originalImage);
      await expect.element(page.getByText("扣除 12 体验积分", { exact: true })).toBeVisible();
      expect(calls.loadJob).toHaveBeenCalledExactlyOnceWith(
        "moss_landscape",
        expect.any(AbortSignal),
      );
      expect(calls.generate).not.toHaveBeenCalled();
      await capture("reconciled");
    },
  );

  it("clears account A tabs and references and rejects its late generation after switching to B", async () => {
    let resolveGeneration!: (value: MossImageJob) => void;
    calls.generate.mockImplementation(
      () =>
        new Promise<MossImageJob>((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    await mountWorkspace();
    await page.getByRole("textbox", { name: "描述要创建的图像" }).fill("账号 A 的私有图像");
    const reference = await (await fetch(originalImage)).blob();
    await page
      .getByLabelText("参考图文件")
      .upload(new File([reference], "private-reference.png", { type: "image/png" }));
    await expect
      .element(page.getByRole("img", { name: "private-reference.png", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "生成图像", exact: true }).click();
    await vi.waitFor(() => expect(calls.generate).toHaveBeenCalledOnce());
    const signal = calls.generate.mock.calls[0]?.[1] as AbortSignal;
    let finishSwitch!: () => void;
    const switchAccount = queryClient.getMutationCache().build(queryClient, {
      mutationKey: mossServerMutationKeys.mossCloudSelect(),
      mutationFn: () =>
        new Promise<void>((resolve) => {
          finishSwitch = resolve;
        }),
    });
    const pendingSwitch = switchAccount.execute(undefined);
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(document.body.textContent).not.toContain("账号 A 的私有图像");
    expect(document.body.textContent).not.toContain("账号 A 的另一个草稿");
    expect(
      page.getByRole("img", { name: "private-reference.png", exact: true }).elements(),
    ).toHaveLength(0);
    catalog = {
      ...catalog,
      account: { id: "account-b", realm: "memfire-phone", creditBalance: 456 },
      models: catalog.models.map((model, index) =>
        index === 0 ? { ...model, label: "账号 B 图像模型" } : model,
      ),
      jobs: [job({ jobId: "moss_b", prompt: "账号 B 的图像" })],
    };
    queryClient.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      authenticated: true,
      session: { user: { id: "account-b" } },
      activeRealm: "cn",
    });
    finishSwitch();
    await pendingSwitch;
    await expect
      .element(page.getByRole("button", { name: "打开图像：账号 B 的图像" }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("账号 B 图像模型");
    resolveGeneration(job({ prompt: "账号 A 的私有图像" }));
    await expect
      .element(page.getByRole("textbox", { name: "描述要创建的图像" }))
      .toHaveTextContent(/^$/);
    expect(document.querySelector("[data-moss-images-result]")).toBeNull();
    expect(document.body.textContent).not.toContain("账号 A 的私有图像");
    expect(calls.wait).not.toHaveBeenCalled();
    await capture("account-b-clean");
  });
});
