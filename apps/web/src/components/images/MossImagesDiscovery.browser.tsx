import "../../index.css";
import { useState } from "react";
import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";
import { MossImagesDiscovery } from "./MossImagesDiscovery";
import {
  MOSS_IMAGE_STYLES,
  MOSS_IMAGE_TEMPLATES,
  type MossImageStyle,
  type MossImageTemplate,
} from "./mossImagesDiscoveryCatalog";

let client: QueryClient;
const useTemplate = vi.fn<(template: MossImageTemplate) => void>();
const selectStyle = vi.fn<(style: MossImageStyle | null) => void>();
const requestReference = vi.fn<(source: "upload" | "recent") => void>();

function Harness({
  templates = MOSS_IMAGE_TEMPLATES,
  supportsReferences = true,
}: {
  templates?: readonly MossImageTemplate[];
  supportsReferences?: boolean;
}) {
  const [owner, setOwner] = useState("account-a:tab-a");
  const [style, setStyle] = useState<MossImageStyle | null>(null);
  const [references, setReferences] = useState(0);
  const [supported, setSupported] = useState(supportsReferences);
  const [disabled, setDisabled] = useState(false);
  return (
    <div className="mx-auto max-w-3xl p-4">
      <button
        type="button"
        onClick={() => {
          setOwner("account-b:tab-a");
          setStyle(null);
          setReferences(0);
        }}
      >
        切换账号
      </button>
      <button
        type="button"
        onClick={() => {
          setOwner("account-a:tab-b");
          setStyle(null);
          setReferences(0);
        }}
      >
        切换标签
      </button>
      <button type="button" onClick={() => setSupported(false)}>
        切换到无参考图模型
      </button>
      <button type="button" onClick={() => setDisabled(true)}>
        设为忙碌
      </button>
      <MossImagesDiscovery
        resetKey={owner}
        disabled={disabled}
        selectedStyle={style}
        onSelectStyle={(value) => {
          selectStyle(value);
          setStyle(value);
        }}
        referenceCount={references}
        supportsReferences={supported}
        onRequestReference={(source) => {
          requestReference(source);
          setReferences(1);
        }}
        onUseTemplate={useTemplate}
        templates={templates}
      />
    </div>
  );
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  return render(
    <QueryClientProvider client={client}>
      <MossLocalizationProvider>
        <Harness {...props} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  await page.viewport(1100, 900);
});

afterEach(async () => {
  await cleanup();
  await client.cancelQueries();
  client.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("opens a meaningful local preview with the keyboard and cancels without using or generating", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await mount();
  const card = page.getByRole("button", { name: "预览海报" });
  (card.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "海报" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByRole("img", { name: "海报模板预览" })).toBeVisible();
  await dialog.getByRole("button", { name: "查看描述" }).click();
  await expect.element(dialog).toHaveTextContent(MOSS_IMAGE_TEMPLATES[0]!.prompt);
  await expect.element(dialog).toHaveStyle({ opacity: "1" });
  await page.screenshot({
    path: "../../../../../output/playwright/moss-images-template-preview.png",
  });
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(card).toHaveFocus();
  expect(useTemplate).not.toHaveBeenCalled();
  expect(requestReference).not.toHaveBeenCalled();
  expect(
    fetchSpy.mock.calls.filter(([, init]) => init?.method?.toUpperCase() === "POST"),
  ).toHaveLength(0);
});

it("uses a template once to prefill and keeps style selection separate", async () => {
  await mount();
  await page.getByRole("tab", { name: "热门" }).click();
  await page.getByRole("button", { name: "选择柔和水彩样式" }).click();
  await page.getByRole("tab", { name: "模板" }).click();
  await page.getByRole("button", { name: "预览徽标" }).click();
  await page.getByRole("button", { name: "使用模板", exact: true }).click();
  expect(useTemplate).toHaveBeenCalledExactlyOnceWith(MOSS_IMAGE_TEMPLATES[2]);
  expect(selectStyle).toHaveBeenCalledExactlyOnceWith(MOSS_IMAGE_STYLES[0]);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await page.getByRole("tab", { name: "热门" }).click();
  await expect
    .element(page.getByRole("button", { name: "选择柔和水彩样式" }))
    .toHaveAttribute("aria-pressed", "true");
});

it.each(["upload", "recent"] as const)(
  "requires a reference and delegates %s without submitting",
  async (source) => {
    await mount();
    await page.getByRole("tab", { name: "模板" }).click();
    await page.getByRole("button", { name: "预览职业形象照" }).click();
    const use = page.getByRole("button", { name: "使用模板", exact: true });
    await expect.element(use).toBeDisabled();
    await page
      .getByRole("button", { name: source === "upload" ? "上传参考图" : "从最近图片选择" })
      .click();
    expect(requestReference).toHaveBeenCalledExactlyOnceWith(source);
    expect(useTemplate).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("已添加参考图");
    await expect.element(use).toBeEnabled();
    await use.click();
    expect(useTemplate).toHaveBeenCalledExactlyOnceWith(MOSS_IMAGE_TEMPLATES[4]);
  },
);

it("explains unavailable reference capabilities and disables their template and style", async () => {
  await mount({ supportsReferences: false });
  await page.getByRole("tab", { name: "热门" }).click();
  await expect.element(page.getByRole("button", { name: "选择主体棚拍样式" })).toBeDisabled();
  await page.getByRole("tab", { name: "模板" }).click();
  await page.getByRole("button", { name: "预览职业形象照" }).click();
  await expect.element(page.getByRole("dialog")).toHaveTextContent("当前模型不支持参考图");
  await expect.element(page.getByRole("button", { name: "使用模板", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "上传参考图" })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(useTemplate).not.toHaveBeenCalled();
  expect(selectStyle).not.toHaveBeenCalled();
});

it("selects, replaces and clears styles without using a template or requesting a generation", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await mount();
  await page.getByRole("tab", { name: "热门" }).click();
  await page.getByRole("button", { name: "选择柔和水彩样式" }).click();
  await page.getByRole("tab", { name: "热门" }).click();
  await page.getByRole("button", { name: "选择几何纸艺样式" }).click();
  await expect
    .element(page.getByRole("button", { name: "选择柔和水彩样式" }))
    .toHaveAttribute("aria-pressed", "false");
  await expect
    .element(page.getByRole("button", { name: "选择几何纸艺样式" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "清除样式" }).click();
  expect(selectStyle.mock.calls.map(([style]) => style?.id ?? null)).toEqual([
    "soft-watercolor",
    "geometric-paper",
    null,
  ]);
  expect(useTemplate).not.toHaveBeenCalled();
  expect(
    fetchSpy.mock.calls.filter(([, init]) => init?.method?.toUpperCase() === "POST"),
  ).toHaveLength(0);
});

it.each(["切换账号", "切换标签"])(
  "closes the old owner's preview when %s changes",
  async (label) => {
    await mount();
    const ownerControl = page.getByRole("button", { name: label }).element() as HTMLButtonElement;
    await page.getByRole("tab", { name: "热门" }).click();
    await page.getByRole("button", { name: "选择主体棚拍样式" }).click();
    await page.getByRole("tab", { name: "模板" }).click();
    await page.getByRole("button", { name: "预览职业形象照" }).click();
    // Owner changes are external navigation, not a click through the modal backdrop.
    ownerControl.click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "清除样式" })).not.toBeInTheDocument();
    expect(useTemplate).not.toHaveBeenCalled();
    expect(requestReference).not.toHaveBeenCalled();
  },
);

it("rechecks model capability while a material preview is open", async () => {
  await mount();
  const modelControl = page
    .getByRole("button", { name: "切换到无参考图模型" })
    .element() as HTMLButtonElement;
  await page.getByRole("tab", { name: "模板" }).click();
  await page.getByRole("button", { name: "预览职业形象照" }).click();
  await page.getByRole("button", { name: "上传参考图" }).click();
  await expect.element(page.getByRole("button", { name: "使用模板", exact: true })).toBeEnabled();
  modelControl.click();
  await expect.element(page.getByRole("button", { name: "使用模板", exact: true })).toBeDisabled();
  expect(useTemplate).not.toHaveBeenCalled();
});

it("shows a failed-image fallback, retries and keeps the template description usable", async () => {
  await page.viewport(390, 844);
  const template = { ...MOSS_IMAGE_TEMPLATES[0]!, previewUrl: "data:image/png;base64,broken" };
  await mount({ templates: [template] });
  await page.getByRole("tab", { name: "模板" }).click();
  await page.getByRole("button", { name: "预览海报" }).click();
  const dialog = page.getByRole("dialog", { name: "海报" });
  await expect.element(dialog.getByRole("img", { name: "海报预览不可用" })).toBeVisible();
  await dialog.getByRole("button", { name: "重新加载预览" }).click();
  await expect.element(dialog.getByRole("img", { name: "海报预览不可用" })).toBeVisible();
  await dialog.getByRole("button", { name: "查看描述" }).click();
  await expect.element(dialog).toHaveTextContent(template.prompt);
  await page.screenshot({
    path: "../../../../../output/playwright/moss-images-template-mobile-fallback.png",
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(useTemplate).not.toHaveBeenCalled();
});

it("blocks actions inside an open portal when the owning workspace becomes unavailable", async () => {
  await mount();
  const busy = page.getByRole("button", { name: "设为忙碌" }).element() as HTMLButtonElement;
  await page.getByRole("tab", { name: "热门" }).click();
  await page.getByRole("button", { name: "选择柔和水彩样式" }).click();
  await page.getByRole("tab", { name: "模板" }).click();
  await page.getByRole("button", { name: "预览职业形象照" }).click();
  await page.getByRole("button", { name: "上传参考图" }).click();
  requestReference.mockClear();
  selectStyle.mockClear();
  busy.click();
  for (const label of ["使用模板", "上传参考图", "从最近图片选择"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect.element(button).toBeDisabled();
    (button.element() as HTMLButtonElement).click();
  }
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const preview = page.getByRole("button", { name: "预览海报", exact: true });
  await expect.element(preview).toBeDisabled();
  (preview.element() as HTMLButtonElement).click();
  await page.getByRole("tab", { name: "热门" }).click();
  for (const label of ["选择几何纸艺样式", "清除样式"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    await expect.element(button).toBeDisabled();
    (button.element() as HTMLButtonElement).click();
  }
  expect(useTemplate).not.toHaveBeenCalled();
  expect(requestReference).not.toHaveBeenCalled();
  expect(selectStyle).not.toHaveBeenCalled();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
