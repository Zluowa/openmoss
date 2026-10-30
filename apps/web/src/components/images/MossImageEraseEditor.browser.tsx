import "../../index.css";
import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, server } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MossLocalizationProvider } from "~/localization";
import { APP_SETTINGS_STORAGE_KEY } from "~/uiLocale";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { MossImageEraseEditor, type MossImageEraseSelection } from "./MossImageEraseEditor";

let file: File;
let client: QueryClient;
let applied: MossImageEraseSelection | undefined;
let application: Promise<MossImageEraseSelection>;
const onApply = vi.fn<(value: MossImageEraseSelection) => Promise<void>>();
const onCancel = vi.fn<() => void>();

async function mount() {
  await render(
    <QueryClientProvider client={client}>
      <MossLocalizationProvider>
        <MossImageEraseEditor file={file} onCancel={onCancel} onApply={onApply} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("img", { name: "擦除选区画布" })).toBeVisible();
}
async function draw() {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="擦除选区画布"]')!;
  const rect = canvas.getBoundingClientRect();
  const markers = [0.3, 0.7].map((x, index) => {
    const marker = document.createElement("span");
    marker.id = `erase-marker-${index}`;
    Object.assign(marker.style, {
      position: "fixed",
      pointerEvents: "none",
      width: "2px",
      height: "2px",
      left: `${rect.left + rect.width * x - 1}px`,
      top: `${rect.top + rect.height / 2 - 1}px`,
    });
    document.body.append(marker);
    return marker;
  });
  try {
    const commands = server.commands as unknown as {
      dragPointerSequence(source: string, target: string, steps: number): Promise<unknown>;
    };
    await commands.dragPointerSequence("#erase-marker-0", "#erase-marker-1", 8);
  } finally {
    markers.forEach((marker) => marker.remove());
  }
}
async function pixels(image: File) {
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      center: Array.from(context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data),
      edge: Array.from(context.getImageData(0, 0, 1, 1).data),
    };
  } finally {
    bitmap.close();
  }
}
beforeEach(async () => {
  vi.resetAllMocks();
  applied = undefined;
  // Both real PNG encodes must finish before inspecting pixels. Their native
  // completion stays bounded by the enclosing test timeout.
  application = new Promise((resolve) => {
    onApply.mockImplementation(async (value) => {
      applied = value;
      resolve(value);
    });
  });
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const source = document.createElement("canvas");
  source.width = 800;
  source.height = 400;
  const context = source.getContext("2d")!;
  context.fillStyle = "#79b9da";
  context.fillRect(0, 0, 800, 400);
  file = new File(
    [await new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!), "image/jpeg"))],
    "original.jpg",
    { type: "image/jpeg" },
  );
  await page.viewport(1280, 900);
});
afterEach(async () => {
  await cleanup();
  await client.cancelQueries();
  client.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("exports same-size source PNG and alpha-zero selection mask, preserving original pixels", async () => {
  await mount();
  await expect.element(page.getByRole("button", { name: "移除选区" })).toBeDisabled();
  await draw();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "移除选区" })).toBeDisabled();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.screenshot({
    path: "../../../../../output/playwright/moss-images-erase-selection.png",
  });
  await page.getByRole("button", { name: "移除选区" }).click();
  await application;
  expect(onApply).toHaveBeenCalledOnce();
  expect(applied!.source.type).toBe("image/png");
  expect(applied!.mask.type).toBe("image/png");
  expect(await pixels(applied!.source)).toEqual(await pixels(file));
  expect(await pixels(applied!.mask)).toEqual({
    width: 800,
    height: 400,
    center: [0, 0, 0, 0],
    edge: [255, 255, 255, 255],
  });
});

it("clears and cancels a selection without accepting an edit", async () => {
  await mount();
  await draw();
  await page.getByRole("button", { name: "清除选区" }).click();
  await expect.element(page.getByRole("button", { name: "移除选区" })).toBeDisabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "移除选区" })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onApply).not.toHaveBeenCalled();
});

it("rejects an oversized PNG instead of shrinking the image", async () => {
  await mount();
  await draw();
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
    callback(new Blob([new Uint8Array(4 * 1024 * 1024)], { type: "image/png" })),
  );
  await page.getByRole("button", { name: "移除选区" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("无法按原尺寸编辑");
  expect(onApply).not.toHaveBeenCalled();
});

it("ignores late PNG preparation after the owned editor closes", async () => {
  await mount();
  await draw();
  const pending: BlobCallback[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    pending.push(callback);
  });
  await page.getByRole("button", { name: "移除选区" }).click();
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await cleanup();
  pending.forEach((callback) => callback(file));
  await Promise.resolve();
  await Promise.resolve();
  expect(onApply).not.toHaveBeenCalled();
});

it("rejects a source wider than the provider mask limit before allowing a selection", async () => {
  const source = document.createElement("canvas");
  source.width = 8193;
  source.height = 1;
  file = new File(
    [await new Promise<Blob>((resolve) => source.toBlob((blob) => resolve(blob!), "image/png"))],
    "too-wide.png",
    { type: "image/png" },
  );
  await render(
    <QueryClientProvider client={client}>
      <MossLocalizationProvider>
        <MossImageEraseEditor file={file} onCancel={onCancel} onApply={onApply} />
      </MossLocalizationProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("alert")).toHaveTextContent("超过编辑尺寸上限");
  await expect.element(page.getByRole("button", { name: "移除选区" })).toBeDisabled();
  expect(page.getByRole("img", { name: "擦除选区画布" }).elements()).toHaveLength(0);
  expect(onApply).not.toHaveBeenCalled();
});
