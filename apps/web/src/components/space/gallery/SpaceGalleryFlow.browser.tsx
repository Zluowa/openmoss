// FILE: SpaceGalleryFlow.browser.tsx
// Purpose: The 资料空间 end to end, through the real destination and a fake NativeApi: the home
//          (新建 and 快速开始 kept, folders, notes and pictures as equals), a 资料空间 with its
//          pages and pictures and its sidebar tree, a picture and its details, the outline on
//          coming back, the canvas, ⌘K search with tags, a 合集, a tag, and a card's menu with
//          在对话中继续. Saves a screenshot of each step when VITE_SPACE_GALLERY_SHOTS names a
//          folder.

import "../../../index.css";
import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  PageId,
  type LibraryFolder,
  type LibraryItem,
  type Page,
  type PageSpace,
} from "@moss/contracts";
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

import { BUILT_IN_TEMPLATES } from "@moss/shared/spaceItems/templates";
import { setLocalImageUrlResolver } from "~/lib/localImageUrls";
import { readMossImagesAccountIdentity } from "~/lib/mossImagesAccountBoundary";
import { MossLocalizationProvider } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";

import { mossServerQueryKeys } from "../../auth/mossServerReactQuery";
import { MossDataSpaceDestination } from "../../MossDataSpaceDestination";
import { TooltipProvider } from "../../ui/tooltip";
import { markWelcomeOffered } from "../welcome/spaceWelcome";
import { useGalleryLocalStore } from "./galleryLocalStore";

// A folder inside the repository (Vite serves and writes only there), e.g. node_modules/.cache/….
const SHOTS = import.meta.env.VITE_SPACE_GALLERY_SHOTS as string | undefined;
const T0 = Date.parse("2026-11-20T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

async function shot(name: string) {
  // Let pictures decode and layout settle before the picture is taken.
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

// ---------------------------------------------------------------------------------------------
// Pictures, drawn here so the test needs no files.

type Painter = (context: CanvasRenderingContext2D, width: number, height: number) => void;

function paint(width: number, height: number, painter: Painter): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  painter(canvas.getContext("2d")!, width, height);
  return canvas.toDataURL("image/png");
}

const scene =
  (sky: [string, string], ground: string, accents: string[]): Painter =>
  (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, sky[0]);
    gradient.addColorStop(1, sky[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = ground;
    context.fillRect(0, height * 0.68, width, height * 0.32);
    accents.forEach((color, index) => {
      context.fillStyle = color;
      const x = (width / (accents.length + 1)) * (index + 1);
      const w = width * 0.18;
      const h = height * (0.28 + (index % 3) * 0.08);
      context.fillRect(x - w / 2, height * 0.68 - h, w, h);
      context.beginPath();
      context.moveTo(x - w / 2 - 6, height * 0.68 - h);
      context.lineTo(x, height * 0.68 - h - h * 0.45);
      context.lineTo(x + w / 2 + 6, height * 0.68 - h);
      context.fill();
    });
  };

const wordmark =
  (background: string, ink: string, text: string): Painter =>
  (context, width, height) => {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.fillStyle = ink;
    const unit = height * 0.18;
    context.fillRect(width * 0.18, height / 2 - unit * 1.2, unit * 0.7, unit * 2.4);
    context.beginPath();
    context.arc(width * 0.18 + unit * 1.4, height / 2 - unit * 0.7, unit * 0.5, 0, Math.PI * 2);
    context.fill();
    context.font = `600 ${Math.round(height * 0.3)}px Inter, sans-serif`;
    context.textBaseline = "middle";
    context.fillText(text, width * 0.18 + unit * 2.4, height / 2);
  };

const geometry =
  (background: string, ink: string): Painter =>
  (context, width, height) => {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.fillStyle = ink;
    const size = Math.min(width, height) * 0.6;
    const x = (width - size) / 2;
    const y = (height - size) / 2;
    context.fillRect(x, y, size / 2, size);
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 2, -Math.PI / 2, Math.PI / 2);
    context.fill();
    context.fillStyle = background;
    context.beginPath();
    context.arc(x + size / 2, y + size / 2, size / 4, -Math.PI / 2, Math.PI / 2);
    context.fill();
  };

const car =
  (background: string, body: string): Painter =>
  (context, width, height) => {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#c9c2b6";
    context.fillRect(0, height * 0.72, width, height * 0.28);
    context.fillStyle = body;
    context.beginPath();
    context.roundRect(width * 0.12, height * 0.45, width * 0.76, height * 0.2, 18);
    context.fill();
    context.beginPath();
    context.roundRect(width * 0.3, height * 0.3, width * 0.38, height * 0.2, 22);
    context.fill();
    context.fillStyle = "#1f1f1f";
    for (const cx of [0.28, 0.72]) {
      context.beginPath();
      context.arc(width * cx, height * 0.66, height * 0.08, 0, Math.PI * 2);
      context.fill();
    }
  };

// ---------------------------------------------------------------------------------------------
// The 资料空间 a person might have.

interface PictureSpec {
  readonly id: string;
  readonly title: string;
  readonly folder: string | null;
  readonly width: number;
  readonly height: number;
  readonly painter: Painter;
  readonly tags: readonly string[];
}

const FOLDERS: ReadonlyArray<{ id: string; title: string; space: boolean }> = [
  { id: "barn", title: "谷仓改造 2025", space: true },
  { id: "studio", title: "工作室 2022", space: false },
  { id: "brand", title: "品牌方向", space: true },
  { id: "inspiration", title: "灵感", space: false },
  { id: "cars", title: "老车收藏", space: false },
];

function pictures(): PictureSpec[] {
  const warm: [string, string] = ["#f3d9c4", "#e9c2a6"];
  const dusk: [string, string] = ["#c9d6e3", "#f1e3d3"];
  return [
    ...[0, 1, 2, 3, 4, 5].map((index) => ({
      id: `barn-${index}`,
      title: `谷仓-${index + 1}.jpg`,
      folder: "barn",
      width: index % 3 === 1 ? 900 : 1200,
      height: index % 3 === 1 ? 1200 : 800,
      painter: scene(index % 2 ? warm : dusk, ["#8d6e55", "#6f7d5c", "#9a8770"][index % 3]!, [
        "#b5543c",
        "#d9cbb8",
        "#7a4b3a",
      ]),
      tags: ["谷仓", index % 2 ? "暖色" : "施工"],
    })),
    ...[0, 1, 2, 3].map((index) => ({
      id: `studio-${index}`,
      title: `工作室-${index + 1}.jpg`,
      folder: "studio",
      width: 1200,
      height: index === 2 ? 1500 : 860,
      painter: scene(["#eae6df", "#d8d1c6"], "#a79c8c", ["#f4f0ea", "#c3b6a3"]),
      tags: ["工作室", "暖色"],
    })),
    {
      id: "logo-light",
      title: "logo-light@2x.png",
      folder: "brand",
      width: 1400,
      height: 800,
      painter: wordmark("#f2f2f0", "#151515", "moss"),
      tags: ["logo", "黑白", "字体"],
    },
    {
      id: "logo-dark",
      title: "logo-dark@2x",
      folder: "brand",
      width: 1000,
      height: 1000,
      painter: wordmark("#1d1d1d", "#f5f5f5", "m"),
      tags: ["logo", "黑白"],
    },
    {
      id: "logo-coral",
      title: "logo-珊瑚.png",
      folder: "brand",
      width: 1400,
      height: 800,
      painter: wordmark("#f6d2c4", "#2a2a2a", "moss"),
      tags: ["logo", "配色"],
    },
    {
      id: "poster-1",
      title: "海报-几何.png",
      folder: "brand",
      width: 900,
      height: 1200,
      painter: geometry("#ece6dc", "#121212"),
      tags: ["海报", "黑白", "几何"],
    },
    {
      id: "poster-2",
      title: "海报-字母.png",
      folder: "brand",
      width: 1200,
      height: 900,
      painter: geometry("#121212", "#ece6dc"),
      tags: ["海报", "黑白", "字体"],
    },
    ...[0, 1, 2].map((index) => ({
      id: `insp-${index}`,
      title: `参考-${index + 1}.png`,
      folder: "inspiration",
      width: 1000,
      height: index === 1 ? 1300 : 760,
      painter:
        index === 1
          ? geometry("#2f5d50", "#e8d9b5")
          : scene(["#dfe7ee", "#f6efe6"], "#85947f", ["#2f5d50", "#e3a04b"]),
      tags: ["灵感", index === 1 ? "几何" : "配色"],
    })),
    {
      id: "car-1",
      title: "1965 野马.jpg",
      folder: "cars",
      width: 1300,
      height: 860,
      painter: car("#dfe3e2", "#1f4f4a"),
      tags: ["汽车", "复古"],
    },
    {
      id: "car-2",
      title: "1970 保时捷 911.jpg",
      folder: "cars",
      width: 1300,
      height: 860,
      painter: car("#f0e8da", "#c34b2d"),
      tags: ["汽车", "复古"],
    },
    {
      id: "car-3",
      title: "Alfa GT.jpg",
      folder: "cars",
      width: 1000,
      height: 1250,
      painter: car("#e7ecef", "#2c6f8f"),
      tags: ["汽车"],
    },
  ];
}

interface NoteSpec {
  readonly id: string;
  readonly title: string;
  readonly folder: string | null;
  readonly content: string;
}

function notes(inlinePicture: string): NoteSpec[] {
  return [
    {
      id: "brand-brief",
      title: "Moss — 品牌简报",
      folder: "brand",
      content: [
        "## 给爱用图片思考的人",
        "一个把笔记和图片放在一起的地方。图片和笔记地位相同，不是附件。所有东西都是你自己文件夹里的普通文件。",
        "## 为什么做",
        "笔记软件为文字而做，可我收集的东西一半是图片。 #品牌 #logo",
      ].join("\n"),
    },
    {
      id: "brand-north",
      title: "Moss — 北极星",
      folder: "brand",
      content: [
        "### 愿景",
        "一个安静的画廊，加一面可以随手摊开的墙。",
        "- 收藏不打扰，一年后还找得到",
        "- 重要的东西摊到画布上继续想",
        "- 删掉应用，什么都不会丢",
        "#品牌",
      ].join("\n"),
    },
    {
      id: "barn-list",
      title: "施工清单",
      folder: "barn",
      content: ["### 本周", "- [x] 量谷仓门", "- [ ] 订窗框", "- [ ] 拍屋顶细节 #施工"].join("\n"),
    },
    {
      id: "illustrators",
      title: "喜欢的插画师",
      folder: null,
      content: [
        "### 林间",
        "独立工作室，动画导演兼插画师。",
        `![林间的车](${inlinePicture})`,
        "色彩大胆，构图干净。 #插画 #配色",
      ].join("\n"),
    },
    {
      id: "this-week",
      title: "这周要做的事",
      folder: null,
      content: [
        "### Moss",
        "- [ ] 定下应用图标，这次真的定",
        "- [ ] 别再把卡片阴影调半个像素",
        "- [ ] 录一段不说“嗯”的演示视频",
        "- [x] 把画廊设为默认（几周前就该做）",
        "### 谷仓",
        "- [ ] 再量一次门，再相信图纸 #待办",
      ].join("\n"),
    },
  ];
}

function buildData() {
  const specs = pictures();
  const urls = new Map<string, string>();
  for (const spec of specs) {
    urls.set(`/pictures/${spec.id}.png`, paint(spec.width / 4, spec.height / 4, spec.painter));
  }
  const inline = paint(240, 300, scene(["#a7d3c9", "#f2e3c9"], "#4f8a4a", ["#e2725b", "#d9c3a6"]));
  const spaces: PageSpace[] = [];
  const pages: Page[] = [];
  const contents = new Map<string, string>();
  const makePage = (id: string, title: string, extra: Partial<Page>, minute: number): Page =>
    ({
      id: PageId.makeUnsafe(id),
      scopeSpaceId: null,
      spaceId: null,
      parentPageId: null,
      rootPageId: PageId.makeUnsafe(id),
      title,
      kind: "page",
      sourceThreadId: null,
      pinned: false,
      trashedAt: null,
      assetIds: [],
      automationIds: [],
      createdAt: at(minute),
      updatedAt: at(minute),
      revision: 1,
      ...extra,
    }) as Page;
  FOLDERS.forEach((folder, index) => {
    if (!folder.space) return;
    const rootId = `${folder.id}-root`;
    spaces.push({
      id: `space-${folder.id}`,
      scopeSpaceId: null,
      rootPageId: PageId.makeUnsafe(rootId),
      title: folder.title,
      revision: 1,
      trashedAt: null,
      createdAt: at(index),
      updatedAt: at(index),
    } as PageSpace);
    pages.push(
      makePage(rootId, folder.title, { spaceId: `space-${folder.id}` as Page["spaceId"] }, index),
    );
  });
  notes(inline).forEach((note, index) => {
    const space = spaces.find((entry) => entry.id === `space-${note.folder}`);
    pages.push(
      makePage(
        note.id,
        note.title,
        space
          ? { spaceId: space.id, rootPageId: space.rootPageId, parentPageId: space.rootPageId }
          : {},
        200 + index * 10,
      ),
    );
    contents.set(note.id, note.content);
  });
  const libraryFolders: LibraryFolder[] = FOLDERS.map((folder, index) => ({
    id: `lib-${folder.id}`,
    title: folder.title,
    createdAt: at(index),
    updatedAt: at(index),
  }));
  const library: LibraryItem[] = specs.map(
    (spec, index) =>
      ({
        id: spec.id,
        title: spec.title,
        kind: "image",
        source: "upload",
        sourceCli: null,
        path: `/pictures/${spec.id}.png`,
        mimeType: spec.title.endsWith(".jpg") ? "image/jpeg" : "image/png",
        size: 180_000 + index * 37_000,
        favorite: false,
        folderId: spec.folder ? `lib-${spec.folder}` : null,
        trashedAt: null,
        // One picture came from a chat, so its card offers 在对话中继续.
        originationThreadId: spec.id === "car-2" ? "thread-cars" : null,
        createdAt: at(100 + index * 5),
        updatedAt: at(100 + index * 5),
      }) as unknown as LibraryItem,
  );
  const tags = Object.fromEntries(specs.map((spec) => [`library:${spec.id}`, [...spec.tags]]));
  return { urls, spaces, pages, contents, libraryFolders, library, tags };
}

// ---------------------------------------------------------------------------------------------

let client: QueryClient;
let restoreTheme: (() => void) | null = null;

/** Pictures the first-run seeding uploaded: path → a URL for their bytes. */
const uploaded = new Map<string, string>();

/** The fake server's clock: each thing made is a second newer than the one before. */
let clockTicks = 0;
const tick = () =>
  new Date(Date.parse("2026-11-01T00:00:00.000Z") + ++clockTicks * 1000).toISOString();

vi.mock("~/lib/libraryUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/libraryUpload")>();
  return {
    ...actual,
    // The 资料库 import route is the server's; here the bytes stay in the page.
    uploadLibraryFiles: vi.fn(async (files: readonly { name: string; data: Blob }[]) => {
      const items = files.map((file) => {
        const id = `welcome-${welcomeLibrary.length}`;
        const path = `/welcome/${id}-${file.name}`;
        uploaded.set(path, URL.createObjectURL(file.data));
        const now = tick();
        return {
          id,
          title: file.name,
          kind: "image",
          source: "upload",
          sourceCli: null,
          path,
          mimeType: "image/webp",
          size: file.data.size,
          favorite: false,
          folderId: null,
          trashedAt: null,
          originationThreadId: null,
          createdAt: now,
          updatedAt: now,
        };
      });
      welcomeLibrary.push(...(items as unknown as LibraryItem[]));
      return { items, imported: items.length, skipped: 0 };
    }),
  };
});

/** The 资料库 of a first-run mount, filled by the seeding. */
const welcomeLibrary: LibraryItem[] = [];
const welcomeFolders: LibraryFolder[] = [];

async function mount(
  theme: "light" | "dark" = "light",
  options: { empty?: boolean; firstRun?: boolean } = {},
) {
  const full = buildData();
  // An empty 资料空间: what a person sees on their first visit.
  const data = options.empty
    ? {
        ...full,
        spaces: [],
        pages: [],
        libraryFolders: [],
        library: [],
        tags: {},
      }
    : full;
  const fixture = createDataSpaceFixture();
  // Typed items (slides, sheets…) made from templates during the first run.
  const typed: Array<{ page: Page; data: string | null }> = [];
  if (options.firstRun) {
    welcomeLibrary.length = 0;
    welcomeFolders.length = 0;
    // The fixture dates every page alike; stamp each with when it was made, as a server would.
    const madeAt = new Map<string, string>();
    const listPages = fixture.api.pages.list;
    const mutatePages = fixture.api.pages.mutate;
    const stamp = (entry: Page): Page => {
      const when = madeAt.get(entry.id);
      return when ? { ...entry, createdAt: when, updatedAt: when } : entry;
    };
    Object.assign(fixture.api.pages, {
      mutate: vi.fn(async (input: Parameters<typeof mutatePages>[0]) => {
        const result = await mutatePages(input);
        if (input.op === "create" || input.op === "create-space")
          madeAt.set(result.page.id, tick());
        return result;
      }),
      list: vi.fn(async (input: Parameters<typeof listPages>[0]) => {
        const result = await listPages(input);
        return { pages: [...result.pages.map(stamp), ...typed.map((entry) => entry.page)] };
      }),
      outputs: vi.fn(async () => ({ outputs: [] })),
    });
    Object.assign(fixture.api.library, {
      list: vi.fn(async () => ({ items: welcomeLibrary, folders: welcomeFolders })),
      createFolder: vi.fn(async ({ id, title }: { id: string; title: string }) => {
        const folder = { id, title, createdAt: at(0), updatedAt: at(0) };
        welcomeFolders.push(folder);
        return { folder };
      }),
      move: vi.fn(async ({ ids, folderId }: { ids: string[]; folderId: string | null }) => {
        for (const [index, item] of welcomeLibrary.entries())
          if (ids.includes(item.id)) welcomeLibrary[index] = { ...item, folderId };
        return { items: welcomeLibrary };
      }),
    });
  } else {
    Object.assign(fixture.api.pages, {
      spaces: vi.fn(async () => ({ spaces: data.spaces })),
      list: vi.fn(async () => ({ pages: data.pages })),
      read: vi.fn(async ({ pageId }: { pageId: string }) => {
        const found = data.pages.find((entry) => entry.id === pageId);
        if (!found) throw new Error(`No page ${pageId}`);
        return { page: found, content: data.contents.get(pageId) ?? "" };
      }),
      outputs: vi.fn(async () => ({ outputs: [] })),
    });
    Object.assign(fixture.api.library, {
      list: vi.fn(async () => ({ items: data.library, folders: data.libraryFolders })),
    });
  }
  Object.assign(fixture.api, {
    pageTypes: {
      read: vi.fn(async ({ pageId }: { pageId: string }) => {
        const found = typed.find((entry) => entry.page.id === pageId);
        if (!found) throw new Error(`No item ${pageId}`);
        return { page: found.page, kind: found.page.kind, data: found.data, dataRevision: 1 };
      }),
      create: vi.fn(
        async (input: {
          kind: Page["kind"];
          title: string;
          spaceId: Page["spaceId"];
          parentPageId: Page["parentPageId"];
          templateId?: string;
          data?: string;
        }) => {
          const id = PageId.makeUnsafe(`typed-${typed.length}`);
          const created = {
            id,
            scopeSpaceId: null,
            spaceId: input.spaceId,
            parentPageId: input.parentPageId,
            rootPageId: input.parentPageId ?? id,
            title: input.title,
            kind: input.kind,
            sourceThreadId: null,
            pinned: false,
            trashedAt: null,
            assetIds: [],
            automationIds: [],
            createdAt: tick(),
            updatedAt: tick(),
            revision: 1,
          } as Page;
          const data =
            input.data ??
            BUILT_IN_TEMPLATES.find((template) => template.id === input.templateId)?.data ??
            null;
          typed.push({ page: created, data });
          return { page: created, kind: input.kind, data, dataRevision: 1 };
        },
      ),
      save: vi.fn(),
      // As the server does: the built-in templates, then the person's own (none here).
      templates: {
        list: vi.fn(async () => ({
          templates: BUILT_IN_TEMPLATES.map((template) => ({
            id: template.id,
            kind: template.kind,
            title: template.title,
            description: template.description,
            category: template.category,
            builtIn: true,
            sourcePageId: null,
            createdAt: null,
          })),
        })),
        delete: vi.fn(),
      },
    },
  });
  window.nativeApi = fixture.api;
  setLocalImageUrlResolver((src) => uploaded.get(src) ?? data.urls.get(src) ?? src);
  useGalleryLocalStore.getState().replaceAll({ tags: data.tags });
  restoreTheme = installBrowserFixtureTheme(theme);

  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: {
      user: { id: fixture.state.account, phoneNumber: "+8613800000000", displayName: null },
    },
    activeRealm: "cn",
  });
  // Only the first-run mount is given the 示例资料; the others show their own data.
  if (!options.firstRun) markWelcomeOffered(readMossImagesAccountIdentity(client));
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MossLocalizationProvider localeOverride="zh-CN">
          <TooltipProvider>
            <BrowserThemeFixture>
              <div style={{ height: "100vh", display: "flex" }}>
                <MossDataSpaceDestination
                  onClose={() => undefined}
                  onStartConversation={async () => undefined}
                  onStartPageConversation={async () => undefined}
                />
              </div>
            </BrowserThemeFixture>
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
  if (options.firstRun) {
    await expect.element(page.getByRole("button", { name: /^文件夹 苔，/u })).toBeVisible();
    return;
  }
  if (options.empty) {
    await expect.element(page.getByRole("region", { name: "新建" })).toBeVisible();
    return;
  }
  await expect.element(page.getByRole("button", { name: /^文件夹 品牌方向/u })).toBeVisible();
  // Notes have their text once their reads land.
  await expect.element(page.getByText("定下应用图标，这次真的定")).toBeVisible();
}

const sidebar = () => page.getByRole("complementary", { name: "资料空间导航" });
const content = () => page.getByRole("main", { name: "资料空间内容" });

describe("资料空间", () => {
  beforeEach(async () => {
    localStorage.clear();
    await page.viewport(1440, 900);
  });
  afterEach(async () => {
    await cleanup();
    client?.clear();
    setLocalImageUrlResolver(null);
    restoreTheme?.();
    restoreTheme = null;
    useGalleryLocalStore.getState().replaceAll({});
    localStorage.clear();
  });

  it("walks home, a space, a picture, the canvas, search, a 合集, a tag and a card menu", async () => {
    await mount();
    const home = content();
    // 1. Home: one quiet header row, then folders, notes and pictures in one grid. A space
    //    with this much in it no longer shows 新建 and 快速开始 (创建 in the sidebar has them).
    await expect
      .element(page.getByRole("button", { name: "文件夹 品牌方向，2 篇笔记 · 5 张图片" }))
      .toBeVisible();
    expect(document.querySelector("[data-space-create-tiles]")).toBeNull();
    await shot("01-home");

    // 1b. Kinds and tags fold away in the sidebar until asked for.
    await sidebar().getByRole("button", { name: "类型", exact: true }).click();
    await sidebar().getByRole("button", { name: "标签", exact: true }).click();
    await shot("02-sidebar-unfolded");
    await sidebar().getByRole("button", { name: "类型", exact: true }).click();

    // 2. A 资料空间: its pages and the pictures of the same-named folder, side by side; the
    //    sidebar opens it and unfolds pages and pictures in one click.
    await page.getByRole("button", { name: /^文件夹 品牌方向/u }).click();
    await expect.element(home.getByRole("heading", { name: "品牌方向" })).toBeVisible();
    await expect.element(sidebar().getByRole("button", { name: "logo-dark@2x" })).toBeVisible();
    await shot("03-space");

    // 3. A picture: large, with its details and tags, and the item's actions above.
    await home.getByRole("button", { name: "图片 logo-dark@2x" }).click();
    const inspector = page.getByRole("complementary", { name: "图片信息" });
    await expect.element(inspector.getByText("PNG", { exact: true })).toBeVisible();
    await inspector.getByRole("button", { name: "添加标签" }).click();
    await inspector.getByRole("textbox", { name: "添加标签" }).fill("深色");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(inspector.getByRole("button", { name: "标签 深色", exact: true }))
      .toBeVisible();
    await shot("04-picture-details");

    // 4. Back: the picture just seen is outlined.
    await home.getByRole("button", { name: "返回" }).click();
    await expect
      .element(home.getByRole("button", { name: "图片 logo-dark@2x" }))
      .toHaveClass(/ring-info/u);
    await shot("05-back-outlined");

    // 5. 画布: the same space spread out; pan, zoom and move cards.
    await home.getByRole("button", { name: "画布视图" }).click();
    await expect.element(page.getByText("图片", { exact: true }).first()).toBeVisible();
    await shot("06-space-canvas");

    // 6. The home canvas: one cluster per folder.
    await sidebar().getByRole("button", { name: "全部", exact: true }).click();
    await expect.element(home.getByText("老车收藏").first()).toBeVisible();
    await page.getByRole("button", { name: "画布视图" }).element().scrollIntoView();
    await shot("07-home-canvas");
    await home.getByRole("button", { name: "网格视图" }).click();

    // 7. ⌘K: tags with counts and a type filter.
    await userEvent.keyboard("{Control>}k{/Control}");
    const search = page.getByRole("dialog");
    await expect.element(search.getByRole("textbox", { name: "搜索资料空间" })).toBeVisible();
    await shot("08-search");

    // 8. Typing offers matching tags; choosing two narrows and offers related ones.
    await userEvent.keyboard("lo");
    await expect.element(search.getByRole("button", { name: /^标签 logo，/u })).toBeVisible();
    await shot("09-search-typing");
    await search.getByRole("button", { name: /^标签 logo，/u }).click();
    await search.getByRole("button", { name: /^标签 黑白，/u }).click();
    await expect.element(search.getByRole("button", { name: "保存为合集…" })).toBeVisible();
    await shot("10-search-tags");

    // 9. Saved as a 合集: it has its own row and view.
    await search.getByRole("button", { name: "保存为合集…" }).click();
    await search.getByRole("textbox", { name: "合集名称" }).fill("黑白标志");
    await search.getByRole("button", { name: "保存", exact: true }).click();
    await expect.element(home.getByRole("heading", { name: "黑白标志" })).toBeVisible();
    await shot("11-collection");

    // 10. A tag from the sidebar.
    await sidebar()
      .getByRole("button", { name: /^黑白\s*\d+$/u })
      .click();
    await expect.element(home.getByRole("heading", { name: "#黑白" })).toBeVisible();
    await shot("12-tag");

    // 11. A folder with no 资料空间, then home again: the folder is outlined.
    await sidebar()
      .getByRole("button", { name: /^老车收藏/u })
      .click();
    await expect.element(home.getByRole("heading", { name: "老车收藏" })).toBeVisible();
    await sidebar().getByRole("button", { name: "全部", exact: true }).click();
    const cars = page.getByRole("button", { name: /^文件夹 老车收藏/u });
    await cars.element().scrollIntoView({ block: "center" });
    await shot("13-home-folder-outlined");

    // 12. The card menu keeps the chat actions: a picture made in a chat continues there.
    await sidebar()
      .getByRole("button", { name: /^老车收藏/u })
      .click();
    await home.getByRole("button", { name: "1970 保时捷 911 的操作" }).click();
    await expect.element(page.getByRole("menuitem", { name: "在对话中继续" })).toBeVisible();
    await shot("14-card-menu");
  });

  it("draws the home in dark", async () => {
    await mount("dark");
    await page
      .getByRole("button", { name: /^文件夹 品牌方向/u })
      .element()
      .scrollIntoView({ block: "center" });
    await shot("15-home-dark");
  });

  it("keeps every way to create: the 创建 menu, AI slides, templates, and the young-space starters", async () => {
    // A full 资料空间: 创建 at the top of the sidebar holds every kind.
    await mount();
    await sidebar().getByRole("button", { name: "创建", exact: true }).click();
    await expect.element(page.getByRole("menuitem", { name: /幻灯片/u })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /画布/u })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /设计/u })).toBeVisible();
    await shot("20-create-menu");

    // 幻灯片 opens the deck dialog: describe it and Moss makes it, or start blank, from a
    // template, a .pptx or a page.
    await page.getByRole("menuitem", { name: /幻灯片/u }).click();
    await expect.element(page.getByRole("dialog", { name: "新建幻灯片" })).toBeVisible();
    await shot("21-create-slides-ai");
    await userEvent.keyboard("{Escape}");

    // 从模板开始: the template library.
    await sidebar().getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("menuitem", { name: /从模板开始/u }).click();
    await expect.element(page.getByRole("dialog", { name: "从模板开始" })).toBeVisible();
    await shot("22-create-templates");
    await userEvent.keyboard("{Escape}");
    await cleanup();

    // A young 资料空间 still greets with 新建 tiles and 快速开始.
    await mount("light", { empty: true });
    await expect.element(content().getByRole("region", { name: "快速开始" })).toBeVisible();
    await shot("23-young-space-starters");
  });

  it("gives a first visit 「苔」: poems beside their pictures, a joined panorama, a deck and a budget", async () => {
    await mount("light", { firstRun: true });
    const home = content();
    await expect
      .element(page.getByRole("button", { name: /^文件夹 苔，6 篇笔记 · 12 张图片 · 2 个其他/u }))
      .toBeVisible();
    // The 欢迎 note stands beside the folder, with things to try.
    await expect.element(home.getByText("先试试这几件事")).toBeVisible();
    await shot("30-first-run-home");

    await page.getByRole("button", { name: /^文件夹 苔，/u }).click();
    await expect.element(home.getByRole("heading", { name: "苔", exact: true })).toBeVisible();
    await expect.element(home.getByText("返景入深林，复照青苔上。")).toBeVisible();
    await expect.element(home.getByRole("button", { name: "图片 苔痕上阶" })).toBeVisible();
    await shot("31-first-run-folder");
    await home.getByRole("button", { name: "图片 苔痕上阶" }).element().scrollIntoView();
    await shot("32-first-run-folder-pictures");

    await home.getByRole("button", { name: "画布视图" }).click();
    await shot("33-first-run-canvas");
    await home.getByRole("button", { name: "网格视图" }).click();

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("苔");
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: /^标签 苔，/u }))
      .toBeVisible();
    await shot("34-first-run-search");
  });
});
