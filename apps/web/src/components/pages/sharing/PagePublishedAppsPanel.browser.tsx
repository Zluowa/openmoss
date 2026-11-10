import "../../../index.css";
import { PageId, PageAppId, type PageShareAppPublicationsInput } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { PagePublishedAppsPanel } from "./PagePublishedAppsPanel";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("~/nativeApi")>()),
  ensurePageSharingApi: () => ({ appPublications: request }),
}));
describe("owner app publication confirmation", () => {
  it.each(["zh-CN", "en"] as const)(
    "publishes only after explicit confirmation and revokes the fixed version (%s)",
    async (locale) => {
      const calls: PageShareAppPublicationsInput[] = [];
      let confirmed: number | null = null;
      let generation = 0;
      const appId = PageAppId.makeUnsafe("browser-app");
      request.mockImplementation(async (input: PageShareAppPublicationsInput) => {
        calls.push(input);
        if (input.op !== "list") {
          if (input.expectedGeneration !== generation)
            throw { code: "conflict", message: "刷新后重试" };
          confirmed = input.op === "publish" ? input.appRevision : null;
          generation++;
        }
        return {
          items: [
            {
              nodePath: [2],
              appId,
              revision: 4,
              title: "计数器",
              generation,
              confirmedRevision: confirmed,
            },
          ],
          nextOffset: null,
        };
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const zh = locale === "zh-CN";
      const entry = { kind: zh ? ("link" as const) : ("site" as const), id: "owner-entry" };
      const mounted = await render(
        <QueryClientProvider client={client}>
          <MossLocaleScope locale={locale}>
            <div className="max-w-lg bg-background p-5 text-foreground">
              <PagePublishedAppsPanel
                account="owner"
                scopeSpaceId={null}
                pageId={PageId.makeUnsafe("host-page")}
                pageRevision={7}
                entry={entry}
                policyVersion="3"
              />
            </div>
          </MossLocaleScope>
        </QueryClientProvider>,
      );
      try {
        await page.getByRole("button", { name: zh ? "开放预览" : "Enable preview" }).click();
        await expect
          .element(
            page.getByText(
              zh
                ? /预览不能访问应用数据库或调用 AI/
                : /preview cannot access the app database or use AI/,
            ),
          )
          .toBeVisible();
        if (zh)
          await page.screenshot({
            path: "node_modules/.cache/page-app-publication-consent-zh.png",
          });
        await page.getByRole("button", { name: zh ? "取消" : "Cancel" }).click();
        expect(calls.every((x) => x.op === "list")).toBe(true);
        await page.getByRole("button", { name: zh ? "开放预览" : "Enable preview" }).click();
        await page.getByRole("button", { name: zh ? "确认开放" : "Confirm preview" }).click();
        await expect
          .element(page.getByText(zh ? "访客可看版本 4" : "Visitors can view version 4"))
          .toBeVisible();
        expect(calls.find((x) => x.op === "publish")).toMatchObject({
          op: "publish",
          entry,
          pageRevision: 7,
          nodePath: [2],
          appId,
          appRevision: 4,
          expectedGeneration: 0,
        });
        await page.getByRole("button", { name: zh ? "撤销预览" : "Revoke preview" }).click();
        await expect
          .element(page.getByText(zh ? "访客暂不可看" : "Hidden from visitors"))
          .toBeVisible();
        expect(calls.filter((x) => x.op !== "list").map((x) => x.op)).toEqual([
          "publish",
          "revoke",
        ]);
        expect(calls.find((x) => x.op === "revoke")).toMatchObject({
          expectedGeneration: 1,
          entry,
          nodePath: [2],
        });
      } finally {
        await mounted.unmount();
        client.clear();
        request.mockReset();
      }
    },
  );
});
