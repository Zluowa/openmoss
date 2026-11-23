// FILE: SpaceTypedHeader.browser.tsx
// Purpose: An opened 数据看板 shows the same chart icon in its header as its 资料空间 sidebar entry
//          (WALK-1 S-18), in the shared title pill.
// Layer: Web component tests

import "../../index.css";

import { PageId, type NativeApi, type Page } from "@moss/contracts";
import { BUILT_IN_TEMPLATES } from "@moss/shared/spaceItems/templates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture } from "~/test/browserThemeFixture";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";

import { spaceKindMeta } from "../space/spaceKinds";
import { SpaceTypedItemView } from "./SpaceTypedItemView";

const DASHBOARD_DATA =
  BUILT_IN_TEMPLATES.find((entry) => entry.id === "builtin:sales-dashboard")?.data ?? "";

const dashPage: Page = {
  id: PageId.makeUnsafe("dash-1"),
  scopeSpaceId: null,
  spaceId: null,
  parentPageId: null,
  rootPageId: PageId.makeUnsafe("dash-1"),
  title: "营收看板",
  kind: "app",
  sourceThreadId: null,
  pinned: false,
  trashedAt: null,
  assetIds: [],
  automationIds: [],
  createdAt: "2026-11-22T08:00:00.000Z",
  updatedAt: "2026-11-22T12:00:00.000Z",
  revision: 1,
};

describe("typed editor header", () => {
  let previousApi: NativeApi | undefined;
  beforeEach(async () => {
    await page.viewport(1280, 800);
    previousApi = window.nativeApi;
    const fixture = createDataSpaceFixture();
    Object.assign(fixture.api, {
      pageTypes: {
        read: vi.fn(async () => ({
          kind: "app",
          page: dashPage,
          data: DASHBOARD_DATA,
          dataRevision: 1,
        })),
        create: vi.fn(),
        save: vi.fn(),
        templates: { list: vi.fn(async () => ({ templates: [] })), delete: vi.fn() },
      },
    });
    window.nativeApi = fixture.api;
  });
  afterEach(async () => {
    await cleanup();
    (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
  });

  it("shows a 数据看板's chart icon in its title pill, as in the sidebar", async () => {
    const Dashboard = spaceKindMeta("dashboard").icon;
    const Screen = () => (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MossLocaleScope locale="zh-CN">
          <BrowserThemeFixture>
            <span data-testid="sidebar-icon">
              <Dashboard aria-hidden className="size-4" />
            </span>
            <div style={{ width: 1200, height: 700, display: "flex", flexDirection: "column" }}>
              <SpaceTypedItemView account="acct" scopeSpaceId={null} pageId={dashPage.id} />
            </div>
          </BrowserThemeFixture>
        </MossLocaleScope>
      </QueryClientProvider>
    );
    const router = createRouter({
      routeTree: createRootRoute({ component: Screen }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await render(<RouterProvider router={router} />);
    const pill = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-space-title-pill]");
      expect(found?.textContent).toContain("营收看板");
      return found!;
    });
    // The same glyph (class names aside: sizes and colours differ by place).
    const glyph = (element: Element | null | undefined) => {
      const copy = element!.cloneNode(true) as Element;
      copy.removeAttribute("class");
      return copy.outerHTML;
    };
    const expected = glyph(
      document.querySelector("[data-testid='sidebar-icon']")?.firstElementChild,
    );
    expect(glyph(pill.firstElementChild)).toBe(expected);
  });
});
