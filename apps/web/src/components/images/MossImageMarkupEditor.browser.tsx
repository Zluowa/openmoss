import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MossLocalizationProvider } from "~/localization";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  MOSS_IMAGE_SKETCH_SIZES,
  MossImageMarkupEditor,
  type MossImageMarkupResult,
} from "./MossImageMarkupEditor";
import { MAX_IMAGE_REFERENCE_BYTES } from "~/lib/mossImagesClient";

let file: File;
let queryClient: QueryClient;
let applied: MossImageMarkupResult | undefined;
let application: Promise<MossImageMarkupResult>;
let onCancel: ReturnType<typeof vi.fn<() => void>>;
const onApply = vi.fn<(result: MossImageMarkupResult) => Promise<void>>();

function canvas() {
  return document.querySelector<HTMLCanvasElement>('canvas[aria-label="图像标注画布"]')!;
}
function pixel(x: number, y: number) {
  return Array.from(canvas().getContext("2d")!.getImageData(x, y, 1, 1).data);
}
async function draw(from: [number, number], to: [number, number]) {
  const rect = canvas().getBoundingClientRect();
  const markers = [from, to].map(([x, y], index) => {
    const marker = document.createElement("span");
    marker.id = `markup-pointer-${index}`;
    Object.assign(marker.style, {
      position: "fixed",
      pointerEvents: "none",
      width: "2px",
      height: "2px",
      left: `${rect.left + x * rect.width - 1}px`,
      top: `${rect.top + y * rect.height - 1}px`,
    });
    document.body.append(marker);
    return marker;
  });
  try {
    const commands = server.commands as unknown as {
      dragPointerSequence(source: string, target: string, steps: number): Promise<unknown>;
    };
    await commands.dragPointerSequence("#markup-pointer-0", "#markup-pointer-1", 8);
  } finally {
    markers.forEach((marker) => marker.remove());
  }
}
async function mount(
  source: { file: File } | { blankCanvas: { width: number; height: number } } = { file },
  waitForCanvas = true,
) {
  await render(
    <QueryClientProvider client={queryClient}>
      <MossLocalizationProvider>
        <MossImageMarkupEditor {...source} onApply={onApply} onCancel={onCancel} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  if (waitForCanvas)
    await expect.element(page.getByRole("img", { name: "图像标注画布" })).toBeVisible();
}
async function outputPixel(x: number, y: number) {
  const image = await createImageBitmap(applied!.file);
  try {
    const output = document.createElement("canvas");
    output.width = image.width;
    output.height = image.height;
    output.getContext("2d")!.drawImage(image, 0, 0);
    return {
      width: image.width,
      height: image.height,
      rgba: Array.from(output.getContext("2d")!.getImageData(x, y, 1, 1).data),
    };
  } finally {
    image.close();
  }
}

beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  applied = undefined;
  onApply.mockClear();
  // PNG encoding uses renderer idle tasks. Await its actual completion within
  // the enclosing test budget, not vi.waitFor's unrelated one-second deadline.
  application = new Promise((resolve) => {
    onApply.mockImplementation(async (result) => {
      applied = result;
      resolve(result);
    });
  });
  onCancel = vi.fn();
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  const source = document.createElement("canvas");
  source.width = 512;
  source.height = 320;
  source.getContext("2d")!.fillStyle = "#79b9da";
  source.getContext("2d")!.fillRect(0, 0, 512, 320);
  file = new File(
    [await new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!), "image/png"))],
    "source.png",
    { type: "image/png" },
  );
  await page.viewport(1280, 900);
});

it.each(MOSS_IMAGE_SKETCH_SIZES)(
  "exports a $label blank sketch at $width by $height with opaque white background",
  async (size) => {
    await mount({ blankCanvas: { width: 1024, height: 1024 } });
    await expect.element(page.getByRole("button", { name: "完成草图" })).toBeDisabled();
    await page.getByRole("button", { name: size.label, exact: true }).click();
    await vi.waitFor(() =>
      expect(canvas().width / canvas().height).toBeCloseTo(size.width / size.height, 2),
    );
    await draw([0.2, 0.5], [0.8, 0.5]);
    await expect.element(page.getByRole("button", { name: "1:1", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "完成草图" }).click();
    await application;
    expect(onApply).toHaveBeenCalledOnce();
    const output = await outputPixel(size.width / 2, size.height / 2);
    expect(output).toEqual({ width: size.width, height: size.height, rgba: [220, 38, 38, 255] });
    expect((await outputPixel(0, 0)).rgba).toEqual([255, 255, 255, 255]);
    expect(applied!.file.name).toBe("image-sketch.png");
    expect(applied!.file.size).toBeLessThanOrEqual(MAX_IMAGE_REFERENCE_BYTES);
  },
);

it("rejects an entirely erased sketch and allows undo, redo, and a fresh size after undoing all marks", async () => {
  await mount({ blankCanvas: { width: 1024, height: 1024 } });
  await draw([0.3, 0.5], [0.7, 0.5]);
  await page.getByRole("button", { name: "擦除标注" }).click();
  await page.getByRole("slider", { name: "标注粗细" }).click();
  await userEvent.keyboard("{End}");
  await draw([0.2, 0.5], [0.8, 0.5]);
  expect(pixel(512, 512)).toEqual([255, 255, 255, 255]);
  await page.getByRole("button", { name: "完成草图" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("草图为空");
  expect(onApply).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(pixel(512, 512)).toEqual([220, 38, 38, 255]);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  expect(pixel(512, 512)).toEqual([255, 255, 255, 255]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("button", { name: "9:16", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "重做", exact: true })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "完成草图" })).toBeDisabled();
});

it("bounds a sketch export and ignores its pending apply after the owner unmounts", async () => {
  await mount({ blankCanvas: { width: 1024, height: 1024 } });
  await draw([0.2, 0.5], [0.8, 0.5]);
  let finish!: BlobCallback;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    finish = callback;
  });
  await page.getByRole("button", { name: "完成草图" }).click();
  await vi.waitFor(() => expect(finish).toBeDefined());
  finish(new Blob([new Uint8Array(MAX_IMAGE_REFERENCE_BYTES + 1)], { type: "image/png" }));
  await expect.element(page.getByRole("alert")).toHaveTextContent("超过 4 MiB");
  expect(onApply).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "完成草图" }).click();
  await cleanup();
  finish(file);
  await Promise.resolve();
  expect(onApply).not.toHaveBeenCalled();
});

it("cancels a blank sketch without exporting or accepting it", async () => {
  const decoded: ImageBitmap[] = [];
  const decode = globalThis.createImageBitmap.bind(globalThis);
  vi.spyOn(globalThis, "createImageBitmap").mockImplementation(
    async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = await decode(...args);
      decoded.push(bitmap);
      return bitmap;
    },
  );
  await mount({ blankCanvas: { width: 1024, height: 1024 } });
  await draw([0.2, 0.5], [0.8, 0.5]);
  const exportImage = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃草图" }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
  expect(exportImage).not.toHaveBeenCalled();
  await cleanup();
  expect(decoded).toHaveLength(1);
  expect(decoded[0]!.width).toBe(0);
});

it("rejects an unsupported blank size before allocating or decoding an image", async () => {
  const decode = vi.spyOn(globalThis, "createImageBitmap");
  await mount({ blankCanvas: { width: 16384, height: 16384 } }, false);
  await expect.element(page.getByRole("alert")).toHaveTextContent("请选择支持的草图尺寸");
  expect(decode).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
});
afterEach(async () => {
  await cleanup();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("draws a real stroke, undoes/redoes it, and exports original-sized pixels without a provider call", async () => {
  await mount();
  const before = pixel(512, 320);
  await draw([0.2, 0.5], [0.8, 0.5]);
  expect(pixel(512, 320)).not.toEqual(before);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(pixel(512, 320)).toEqual(before);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  expect(pixel(512, 320)).not.toEqual(before);
  await page.getByRole("button", { name: "完成标注" }).click();
  await application;
  expect(onApply).toHaveBeenCalledOnce();
  const output = await outputPixel(256, 160);
  expect(output.width).toBe(512);
  expect(output.height).toBe(320);
  expect(output.rgba).toEqual([220, 38, 38, 255]);
  const untouched = await createImageBitmap(file);
  untouched.close();
  expect(applied!.comments).toBe("");
});

it("erases only markup while preserving opaque original pixels", async () => {
  await mount();
  const before = pixel(512, 320);
  await draw([0.2, 0.5], [0.8, 0.5]);
  await page.getByRole("button", { name: "擦除标注" }).click();
  await draw([0.5, 0.2], [0.5, 0.8]);
  expect(pixel(512, 320)).toEqual(before);
  await page.getByRole("button", { name: "完成标注" }).click();
  await application;
  expect(applied).toBeDefined();
  expect(onApply).toHaveBeenCalledOnce();
  expect((await outputPixel(256, 160)).rgba).toEqual([121, 185, 218, 255]);
});

it.each(["线条", "箭头", "矩形", "椭圆", "三角形", "菱形", "星形", "心形"])(
  "draws and selects the %s shape through the real toolbar",
  async (shape) => {
    await mount();
    await page.getByRole("button", { name: "形状", exact: true }).click();
    await page.getByRole("menuitem", { name: shape, exact: true }).click();
    await draw([0.2, 0.2], [0.6, 0.6]);
    await page.getByRole("button", { name: "选择", exact: true }).click();
    await page.getByRole("img", { name: "图像标注画布" }).click({
      position: {
        x: canvas().getBoundingClientRect().width * 0.4,
        y: canvas().getBoundingClientRect().height * 0.4,
      },
    });
    await expect.element(page.getByRole("button", { name: "删除标注" })).toBeEnabled();
    await page.getByRole("button", { name: "删除标注" }).click();
    await expect.element(page.getByRole("button", { name: "完成标注" })).toBeDisabled();
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByRole("button", { name: "完成标注" }).click();
    await application;
    expect(applied).toBeDefined();
    expect(onApply).toHaveBeenCalledOnce();
    expect(applied!.document).toHaveLength(1);
    expect(applied!.file.size).toBeGreaterThan(file.size);
  },
);

it("adds text and normalized comment instructions and cancels without accepting the draft", async () => {
  await mount();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByRole("textbox", { name: "标注文字" }).fill("标题");
  await page.getByRole("img", { name: "图像标注画布" }).click({ position: { x: 100, y: 80 } });
  await page.getByRole("button", { name: "评论", exact: true }).click();
  await page.getByRole("textbox", { name: "评论内容" }).fill("把这里改为绿色");
  await page.getByRole("img", { name: "图像标注画布" }).click();
  await page.getByRole("button", { name: "完成标注" }).click();
  await application;
  expect(applied).toBeDefined();
  expect(onApply).toHaveBeenCalledOnce();
  expect(applied!.comments).toMatch(/^1\. \(x: 50\.0%, y: 50\.0%\) 把这里改为绿色$/);
  expect(applied!.document).toHaveLength(2);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "继续标注" }).click();
  expect(onCancel).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃标注" }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onApply).toHaveBeenCalledOnce();
});

it("ignores a late canvas export after its account-owned editor unmounts", async () => {
  await mount();
  await draw([0.2, 0.5], [0.8, 0.5]);
  let finish!: BlobCallback;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    finish = callback;
  });
  await page.getByRole("button", { name: "完成标注" }).click();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await cleanup();
  finish(file);
  await Promise.resolve();
  expect(onApply).not.toHaveBeenCalled();
});

it("moves and resizes a selected shape, with a new edit replacing the redo branch", async () => {
  await mount();
  await page.getByRole("button", { name: "形状", exact: true }).click();
  await page.getByRole("menuitem", { name: "矩形", exact: true }).click();
  await draw([0.2, 0.2], [0.4, 0.4]);
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await draw([0.3, 0.3], [0.4, 0.4]);
  await draw([0.5, 0.5], [0.7, 0.7]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "重做", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "画笔", exact: true }).click();
  await draw([0.1, 0.8], [0.9, 0.8]);
  await expect.element(page.getByRole("button", { name: "重做", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "完成标注" }).click();
  await application;
  expect(applied).toBeDefined();
  expect(onApply).toHaveBeenCalledOnce();
  expect(applied!.document[0]!.points[0]!.x).toBeCloseTo(307.2, 0);
  expect(applied!.document[0]!.points.at(-1)!.x).toBeCloseTo(512, 0);
  expect(applied!.document).toHaveLength(2);
});

it("discards a draft without preparing an image or accepting it", async () => {
  await mount();
  await draw([0.2, 0.5], [0.8, 0.5]);
  await page.screenshot({ path: "../../../../../output/playwright/moss-images-markup-editor.png" });
  const exportImage = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "放弃标注" }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
  expect(exportImage).not.toHaveBeenCalled();
});
