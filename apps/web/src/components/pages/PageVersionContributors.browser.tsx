import "../../index.css";
import { PageId, ThreadId, type Page, type PageVersion } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { PageActivityPanel, PageHistoryPanel } from "./PageSidePanels";

const account = "history-fixture";
const ownerPage: Page = {
  id: PageId.makeUnsafe("history-page"),
  scopeSpaceId: null,
  spaceId: null,
  parentPageId: null,
  rootPageId: PageId.makeUnsafe("history-page"),
  title: "编辑记录",
  revision: 3,
  pinned: false,
  trashedAt: null,
  sourceThreadId: null,
  assetIds: [],
  automationIds: [],
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:03:00.000Z",
};
const one = {
  content: "",
  operation: "update",
  author: "local-user",
  authorThreadId: null,
} as const;
const versions: PageVersion[] = [
  {
    ...one,
    page: ownerPage,
    createdAt: ownerPage.updatedAt,
    contributors: [
      { kind: "local-user" },
      { kind: "agent", threadId: ThreadId.makeUnsafe("hidden-thread-A") },
      { kind: "agent", threadId: ThreadId.makeUnsafe("hidden-thread-B") },
    ],
  },
  {
    ...one,
    page: { ...ownerPage, revision: 2 },
    createdAt: "2026-11-06T00:02:00.000Z",
    contributors: [{ kind: "unrecorded" }],
  },
  { ...one, page: { ...ownerPage, revision: 1 }, createdAt: ownerPage.createdAt },
];
const status = { loading: false, error: null, onRetry() {} };

describe("Page edit sources in history and activity", () => {
  it.each(["zh-CN", "en"] as const)(
    "shows source categories and missing records in %s, including expanded history",
    async (locale) => {
      const cache = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
      });
      const root = pagesQueryKeys.read(account, null, ownerPage.id);
      cache.setQueryData([...root, "version-summaries", 3], {
        pages: [{ versions }],
        pageParams: [undefined],
      });
      cache.setQueryData([...root, "revision", 3], {
        page: ownerPage,
        content: "Meeting notes: changes saved.",
      });
      const mounted = await render(
        <QueryClientProvider client={cache}>
          <MossLocaleScope locale={locale}>
            <div
              data-testid="source-panels"
              className="grid max-w-3xl gap-3 bg-background p-4 text-foreground sm:grid-cols-2"
            >
              <div>
                <h2>{locale === "en" ? "History" : "历史"}</h2>
                <PageHistoryPanel
                  account={account}
                  scopeSpaceId={null}
                  page={ownerPage}
                  busy={false}
                  onRestore={async () => {}}
                />
              </div>
              <div>
                <h2>{locale === "en" ? "Activity" : "页面动态"}</h2>
                <PageActivityPanel
                  account={account}
                  scopeSpaceId={null}
                  page={ownerPage}
                  comments={[]}
                  localStatus={status}
                  shareStatus={status}
                />
              </div>
            </div>
          </MossLocaleScope>
        </QueryClientProvider>,
      );
      try {
        const collaborative =
          locale === "en"
            ? /Collaborative edit · Local editor & Assistant/
            : /协作编辑 · 本机编辑者和助手/;
        const absent =
          locale === "en" ? /Collaboration sources were not recorded/ : /未记录协作来源/;
        const button = page.getByRole("button", { name: collaborative });
        await expect.element(button).toBeVisible();
        await expect.element(page.getByRole("button", { name: absent })).toBeVisible();
        const activity = page.getByRole("list", { name: "页面动态" });
        await expect.element(activity).toHaveTextContent(collaborative);
        await expect.element(activity).toHaveTextContent(absent);
        await button.click();
        await expect.element(page.getByText("Meeting notes: changes saved.")).toBeVisible();
        const copy = document.querySelector('[data-testid="source-panels"]')!.textContent ?? "";
        expect(copy).not.toMatch(/hidden-thread|\d+\s*(?:人|people|contributors)/i);
        if (locale === "zh-CN")
          await page.screenshot({ path: "node_modules/.cache/page-history-sources-zh.png" });
      } finally {
        await mounted.unmount();
        cache.clear();
      }
    },
  );
});
