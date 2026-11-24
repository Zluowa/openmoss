// FILE: SpaceHomeLook.browser.tsx
// Purpose: What a person sees on the 资料空间 home (WALK-1): quiet 新建 tiles with no gradient, in
//          light and dark (S-7); an empty document's card shows its title (S-11); the sidebar is
//          not selectable as text (S-20); on a narrow window the quick-start titles stay whole and
//          the kind tags give way (S-21).
// Layer: Web component tests

import "../../index.css";

import { PageId, type NativeApi, type Page } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";

import { SpaceHome } from "./SpaceHome";
import { SpaceSidebar } from "./SpaceSidebar";
import { buildSpaceItems, recentItems, setSyncedSpaceHomeKind } from "./spaceItems";
import { spaceKindMeta } from "./spaceKinds";
import { getCentralIconUrl } from "~/lib/central-icons";
import { centralIconNameOf } from "~/lib/icons";

function makePage(id: string, title: string): Page {
  return {
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
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T12:00:00.000Z",
    revision: 1,
  };
}

/** sRGB channels (0..1) of a computed colour, `rgb(…)` or `color(srgb …)`. */
function channels(color: string): [number, number, number] {
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/u.exec(color);
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  throw new Error(`unreadable colour ${color}`);
}

function renderHome(width: number) {
  const docPage = makePage("doc-1", "季度计划");
  const items = buildSpaceItems({ pages: [docPage], apps: [], outputs: [] });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MossLocaleScope locale="zh-CN">
        <BrowserThemeFixture>
          <div className="flex h-screen bg-background text-foreground" style={{ width }}>
            <SpaceSidebar
              scopeSpaceId={null}
              section={{ type: "all" }}
              openKey={null}
              recent={recentItems(items)}
              spaces={[]}
              pages={[docPage]}
              onSection={() => {}}
              onOpen={() => {}}
              onOpenPage={() => {}}
              onCreate={() => {}}
              onCreateSubpage={() => {}}
              onRenameSpace={() => {}}
              onSpaceIcon={() => {}}
              onTrashSpace={() => {}}
              onClose={() => {}}
            />
            <SpaceHome
              section={{ type: "all" }}
              title="资料空间"
              description=""
              items={items}
              loading={false}
              error={null}
              onRetry={() => {}}
              onCreate={() => {}}
              onOpen={() => {}}
              placeOf={() => "个人"}
              emptyCreate="page"
            />
          </div>
        </BrowserThemeFixture>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

describe("资料空间 home, as a person sees it", () => {
  let previousApi: NativeApi | undefined;
  let restoreTheme: (() => void) | null = null;

  beforeEach(() => {
    window.localStorage.removeItem("moss:space:hide-create-tiles");
    window.localStorage.removeItem("moss:space:hide-quick-start");
    setSyncedSpaceHomeKind("any");
    previousApi = window.nativeApi;
    const fixture = createDataSpaceFixture();
    // The empty document: no body yet, only its title.
    Object.assign(fixture.api.pages, {
      read: vi.fn(async () => ({ page: makePage("doc-1", "季度计划"), content: "", versions: [] })),
    });
    window.nativeApi = fixture.api;
  });

  afterEach(async () => {
    await cleanup();
    restoreTheme?.();
    restoreTheme = null;
    (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
    document.documentElement.classList.remove("dark");
  });

  for (const mode of ["light", "dark"] as const) {
    it(`draws 新建 tiles as a flat quiet tint, never a gradient (${mode})`, async () => {
      await page.viewport(1280, 900);
      restoreTheme = installBrowserFixtureTheme(mode);
      await renderHome(1280);
      const tiles = await vi.waitFor(() => {
        const found = [...document.querySelectorAll<HTMLElement>("[data-space-create-tile]")];
        expect(found.length).toBe(6);
        return found;
      });
      const card = channels(
        getComputedStyle(document.querySelector("[data-space-item]")!).backgroundColor,
      );
      for (const tile of tiles) {
        const style = getComputedStyle(tile);
        expect(style.backgroundImage, tile.dataset.spaceCreateTile).toBe("none");
        // Quiet: the tile stays within a small step of the card surface around it.
        const fill = channels(style.backgroundColor);
        const step = Math.max(...fill.map((value, index) => Math.abs(value - card[index]!)));
        expect(step, tile.dataset.spaceCreateTile).toBeLessThan(0.12);
      }
    });
  }

  it("draws 画布 with its type's one icon on the 新建 tile and in the sidebar", async () => {
    await page.viewport(1280, 900);
    await renderHome(1280);
    // The same entry the chat dock's 画布 tab, launcher and + menu draw (WALK-4 N4-2).
    const mask = getCentralIconUrl(centralIconNameOf(spaceKindMeta("board").icon)!)!;
    const drawn = (root: Element | null | undefined) =>
      root?.querySelector<HTMLElement>('[data-slot="central-icon"]')?.getAttribute("style") ?? "";
    await vi.waitFor(() => {
      expect(drawn(document.querySelector('[data-space-create-tile="board"]'))).toContain(mask);
      const sidebarRow = [...document.querySelectorAll<HTMLElement>("button, a")].find(
        (element) => element.textContent?.trim() === "画布",
      );
      expect(drawn(sidebarRow)).toContain(mask);
    });
  });

  it("shows an empty document's title on its card", async () => {
    await page.viewport(1280, 900);
    await renderHome(1280);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-space-card-preview="page"]')?.textContent).toContain(
        "季度计划",
      ),
    );
  });

  it("does not paint the sidebar blue on select-all", async () => {
    await page.viewport(1280, 900);
    await renderHome(1280);
    const sidebar = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-space-sidebar]");
      expect(found).not.toBeNull();
      return found!;
    });
    window.getSelection()?.selectAllChildren(document.body);
    expect(getComputedStyle(sidebar).userSelect).toBe("none");
    window.getSelection()?.removeAllRanges();
  });

  it("keeps quick-start titles whole on a narrow window; the kind tags give way", async () => {
    await page.viewport(854, 900);
    await renderHome(854);
    const cards = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>("[data-space-quick-start-template]"),
      ];
      expect(found.length).toBe(3);
      return found;
    });
    for (const card of cards) {
      const title = card.querySelector<HTMLElement>(".truncate")!;
      expect(title.scrollWidth, title.textContent ?? "").toBeLessThanOrEqual(title.clientWidth);
      const tag = card.querySelector<HTMLElement>("[data-slot='badge']");
      if (tag) expect(tag.getBoundingClientRect().width).toBe(0);
    }
  });

  it("shows the kind tags on quick-start cards at a normal width", async () => {
    await page.viewport(1440, 900);
    await renderHome(1440);
    const tags = await vi.waitFor(() => {
      const found = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-space-quick-start-template] [data-slot='badge']",
        ),
      ];
      expect(found.length).toBe(3);
      return found;
    });
    for (const tag of tags) expect(tag.getBoundingClientRect().width).toBeGreaterThan(0);
  });
});
