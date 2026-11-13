// FILE: DesignInSpace.browser.tsx
// Purpose: The 设计 kind inside the real 资料空间: the 创建 menu offers 设计 next to the other kinds,
//          picking it creates a design and opens the editor in the space's page view (layout
//          unchanged), a template design shows its artboards, and the panel edits them.
//          With VITE_MOSS_DESIGN_SHOTS=1 it also saves walk screenshots (light and dark).
// Layer: Browser tests (headless Chromium); only the NativeApi boundary is a fixture.

import "../../../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  PageId,
  type NativeApi,
  type PageTypedItem,
  type PageTypesCreateInput,
  type PageTypesSaveInput,
} from "@moss/contracts";
import { emptyItemData, parseItemData, type TypedItemKind } from "@moss/shared/spaceItems/itemData";
import { findBuiltInTemplate } from "@moss/shared/spaceItems/templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { resetThemeSnapshotCacheForTests, useTheme } from "~/hooks/useTheme";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";
import { DEFAULT_THEME_STATE, serializeThemeState } from "~/theme/theme.logic";
import { mossServerQueryKeys } from "../../auth/mossServerReactQuery";
import { MossDataSpaceDestination } from "../../MossDataSpaceDestination";
import { TooltipProvider } from "../../ui/tooltip";

const SHOTS = import.meta.env.VITE_MOSS_DESIGN_SHOTS === "1";
async function shot(name: string) {
  if (SHOTS)
    await page.screenshot({ path: `../../../../node_modules/.cache/design-walk/${name}.png` });
}

let fixture: ReturnType<typeof createDataSpaceFixture>;
let previousApi: NativeApi | undefined;
const items = new Map<string, PageTypedItem>();

function typedItems(api: NativeApi) {
  let next = 1;
  const created = new Map<string, PageTypedItem>();
  (api as { pageTypes: unknown }).pageTypes = {
    create: async (input: PageTypesCreateInput) => {
      const key = input.requestId;
      const existing = created.get(key);
      if (existing) return existing;
      const id = PageId.makeUnsafe(`typed-${next++}`);
      const kind = input.kind as TypedItemKind;
      const template = input.templateId ? findBuiltInTemplate(input.templateId) : undefined;
      const data = parseItemData(
        kind,
        input.data ?? template?.data ?? emptyItemData(kind),
        input.title,
      );
      const document = pageDocument(id, input.title, data.content);
      const item: PageTypedItem = {
        page: { ...document.page, kind },
        kind,
        data: data.data,
        dataRevision: 1,
      };
      fixture.put({ page: item.page, content: data.content });
      items.set(id, item);
      created.set(key, item);
      return item;
    },
    read: async ({ pageId }: { pageId: string }) => {
      const item = items.get(pageId);
      if (!item) throw new Error("not found");
      return structuredClone(item);
    },
    save: async (input: PageTypesSaveInput) => {
      const item = items.get(input.pageId)!;
      if (item.page.revision !== input.expectedRevision)
        throw Object.assign(new Error("conflict"), { code: "conflict" });
      const revision = item.page.revision + 1;
      const saved: PageTypedItem = {
        ...item,
        page: { ...item.page, revision, ...(input.title ? { title: input.title } : {}) },
        data: parseItemData(item.kind as TypedItemKind, input.data).data,
        dataRevision: revision,
      };
      items.set(input.pageId, saved);
      fixture.put({ page: saved.page, content: "" });
      return structuredClone(saved);
    },
    templates: {
      list: async () => ({ templates: [] }),
      save: async () => {
        throw new Error("not in this test");
      },
      delete: async () => ({ templates: [] }),
    },
  };
}

/** The app shell applies the stored theme through useTheme; this test mounts only the space. */
function ThemeRoot() {
  useTheme();
  return null;
}

async function mount(theme: "light" | "dark" = "light") {
  // The theme comes from storage in its stored form; the cache is cleared so this mount reads it.
  window.localStorage.setItem(
    "moss:theme",
    serializeThemeState({ ...DEFAULT_THEME_STATE, mode: theme }),
  );
  resetThemeSnapshotCacheForTests();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: {
      user: { id: fixture.state.account, phoneNumber: "+8613800000000", displayName: "测试用户" },
    },
    activeRealm: "cn",
  });
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <ThemeRoot />
          <TooltipProvider>
            <div style={{ height: "100vh", display: "flex" }}>
              <MossDataSpaceDestination
                onClose={() => undefined}
                onStartConversation={async () => undefined}
                onStartPageConversation={async () => undefined}
              />
            </div>
          </TooltipProvider>
        </MossLocalizationProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  await expect
    .element(page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }))
    .toBeVisible();
  // useTheme listens only while mounted, so the theme is announced after the first render.
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await expect
    .poll(() => window.document.documentElement.classList.contains("dark"))
    .toBe(theme === "dark");
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  previousApi = window.nativeApi;
  fixture = createDataSpaceFixture();
  items.clear();
  typedItems(fixture.api);
  window.nativeApi = fixture.api;
});
afterEach(async () => {
  await cleanup();
  (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
  window.localStorage.removeItem("moss:theme");
  resetThemeSnapshotCacheForTests();
  window.document.documentElement.classList.remove("dark");
});

const createTrigger = () => document.querySelector<HTMLElement>("[data-space-create-trigger]")!;

describe("设计 in the 资料空间", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`offers 设计 in the 创建 menu and opens a new design in the space (${theme})`, async () => {
      await mount(theme);
      await shot(`01-space-home-${theme}`);
      createTrigger().click();
      const entry = page.getByRole("menuitem", { name: "设计", exact: true });
      await expect.element(entry).toBeVisible();
      // Same list and look as the other kinds: 设计 comes right after 白板.
      const kinds = [...document.querySelectorAll("[data-space-create]")].map((element) =>
        element.getAttribute("data-space-create"),
      );
      expect(kinds.indexOf("design")).toBe(kinds.indexOf("board") + 1);
      await shot(`02-create-menu-${theme}`);
      await entry.click();
      await expect.element(page.getByText("这一页还没有画板", { exact: true })).toBeVisible();
      expect([...items.values()].map((item) => item.kind)).toEqual(["design"]);
      expect(document.querySelector('[data-typed-item="design"]')).not.toBeNull();
      await shot(`03-new-design-empty-${theme}`);
      await page.getByRole("button", { name: "手机 390×844", exact: true }).click();
      await expect
        .poll(() => document.querySelectorAll("iframe[data-design-frame]").length)
        .toBe(1);
      await expect
        .poll(() => document.querySelector("[data-save-state]")?.getAttribute("data-save-state"), {
          timeout: 5_000,
        })
        .toBe("saved");
      const saved = [...items.values()][0]!;
      expect(saved.page.revision).toBeGreaterThan(1);
      expect(saved.data).toContain('"w":390');
    });
  }

  it("opens a template design with its artboards, selects one and edits it from the panel", async () => {
    await mount();
    const created = await fixture.api.pageTypes.create({
      requestId: "walk-template",
      scopeSpaceId: null,
      kind: "design",
      title: "点餐应用",
      spaceId: null,
      parentPageId: null,
      templateId: "builtin:design-phone-app",
    });
    // Leave and come back so the list shows it, then open it from 最近.
    await page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }).click();
    await page.getByRole("button", { name: "点餐应用", exact: true }).first().click();
    await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(3);
    await expect
      .poll(() => document.querySelector('[data-design-strip="home"]')?.textContent ?? "")
      .toContain("首页");
    await shot("04-template-canvas-light");
    const strip = document.querySelector<HTMLElement>('[data-design-strip="detail"]')!;
    const box = strip.getBoundingClientRect();
    const at = {
      bubbles: true,
      clientX: box.left + 4,
      clientY: box.top + 4,
      button: 0,
      pointerId: 3,
    };
    strip.dispatchEvent(new PointerEvent("pointerdown", at));
    strip.dispatchEvent(new PointerEvent("pointerup", at));
    await expect
      .element(page.getByRole("textbox", { name: "画板名称", exact: true }))
      .toHaveValue("详情");
    await shot("05-artboard-selected-light");
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-design-frame="detail"]')!;
    await expect
      .poll(() => frame.contentDocument?.querySelector("h1")?.textContent)
      .toBe("[详情标题]");
    // Select the heading inside the artboard: the panel shows its text section. The view may
    // still settle after the frames load, so each try measures where the heading is now.
    const canvas = document.querySelector<HTMLElement>("[data-design-canvas]")!;
    const clickHeading = () => {
      const target = document.querySelector<HTMLIFrameElement>(
        'iframe[data-design-frame="detail"]',
      );
      const heading = target?.contentDocument?.querySelector("h1")?.getBoundingClientRect();
      if (!target || !heading) return false;
      const frameBox = target.getBoundingClientRect();
      const scale = frameBox.width / 390;
      const point = {
        bubbles: true,
        clientX: frameBox.left + (heading.x + 4) * scale,
        clientY: frameBox.top + (heading.y + 4) * scale,
        button: 0,
        pointerId: 4,
      };
      canvas.dispatchEvent(new PointerEvent("pointerdown", point));
      canvas.dispatchEvent(new PointerEvent("pointerup", point));
      return document.querySelector('input[aria-label="字号"]') !== null;
    };
    await expect.poll(clickHeading, { interval: 250, timeout: 10_000 }).toBe(true);
    await expect.element(page.getByRole("textbox", { name: "字号", exact: true })).toBeVisible();
    await shot("06-element-selected-light");
    // Play the prototype full window, then leave with Escape.
    await page.getByRole("button", { name: "播放原型", exact: true }).click();
    await expect.poll(() => document.querySelector("[data-design-player]")).not.toBeNull();
    await expect
      .poll(() => document.querySelector("[data-design-player] iframe")?.getAttribute("sandbox"))
      .toBe("allow-scripts allow-forms");
    await shot("07-play-full-window");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect.poll(() => document.querySelector("[data-design-player]")).toBeNull();
    expect(created.kind).toBe("design");
  });

  // Walk pictures only (VITE_MOSS_DESIGN_SHOTS=1): the editor in dark with its menus, panels
  // and a comment. Nothing here is asserted beyond what the pictures need.
  it.skipIf(!SHOTS)("walk shots: the editor in dark, menus, panels and a comment", async () => {
    await mount("dark");
    await fixture.api.pageTypes.create({
      requestId: "walk-dark",
      scopeSpaceId: null,
      kind: "design",
      title: "点餐应用",
      spaceId: null,
      parentPageId: null,
      templateId: "builtin:design-phone-app",
    });
    await page.getByRole("navigation").getByRole("button", { name: "全部", exact: true }).click();
    await page.getByRole("button", { name: "点餐应用", exact: true }).first().click();
    await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(3);
    await expect
      .poll(() =>
        [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-design-frame]")].every(
          (frame) => frame.contentDocument?.querySelector("h1") !== null,
        ),
      )
      .toBe(true);
    await shot("08-editor-dark");
    await page.getByRole("button", { name: "形状：选择工具", exact: true }).click();
    await expect.poll(() => document.querySelector("[data-design-tool-option]")).not.toBeNull();
    await shot("09-shape-tools-menu-dark");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector("[data-design-tool-option]")).toBeNull();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: "SVG", exact: true })).toBeVisible();
    await shot("10-export-menu-dark");
    await userEvent.keyboard("{Escape}");
    await page.getByRole("tab", { name: "图层", exact: true }).click();
    await shot("11-layers-panel-dark");
    await page.getByRole("tab", { name: "属性", exact: true }).click();
    // A comment on the detail artboard's heading.
    document.querySelector<HTMLElement>('[data-testid="design-tool-comment"]')!.click();
    const canvas = document.querySelector<HTMLElement>("[data-design-canvas]")!;
    const commentOnHeading = () => {
      const target = document.querySelector<HTMLIFrameElement>(
        'iframe[data-design-frame="detail"]',
      );
      const heading = target?.contentDocument?.querySelector("h1")?.getBoundingClientRect();
      if (!target || !heading) return false;
      const frameBox = target.getBoundingClientRect();
      const scale = frameBox.width / 390;
      const point = {
        bubbles: true,
        clientX: frameBox.left + (heading.x + 4) * scale,
        clientY: frameBox.top + (heading.y + 4) * scale,
        button: 0,
        pointerId: 5,
      };
      if (!document.querySelector("textarea")) {
        canvas.dispatchEvent(new PointerEvent("pointerdown", point));
        canvas.dispatchEvent(new PointerEvent("pointerup", point));
      }
      return document.querySelector("textarea") !== null;
    };
    await expect.poll(commentOnHeading, { interval: 250, timeout: 10_000 }).toBe(true);
    await page
      .elementLocator(document.querySelector<HTMLTextAreaElement>("textarea")!)
      .fill("标题再大一点，和首页统一。");
    await shot("12-comment-dark");
  });
});
