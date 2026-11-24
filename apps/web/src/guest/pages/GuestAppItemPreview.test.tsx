// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:3000/p/share"}
import type { PageGuestView, PageGuestViewRequest } from "@moss/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GuestAppItemPreview } from "./GuestAppItemPreview";
import type { GuestAppPreviewTransport } from "./guestAppPreviewTransport";
import { pageGuestCopy } from "./pageGuestCopy";

const CONTENT_ORIGIN = "http://127.0.0.1:4999";
const CAPABILITY = { protocolVersion: 1, contentOrigin: CONTENT_ORIGIN };

afterEach(() => {
  cleanup();
  document.head.querySelector('meta[name="moss-app-preview-origin"]')?.remove();
});

describe("GuestAppItemPreview", () => {
  it("says once that the preview saves nothing and lasts 5 minutes", async () => {
    const meta = document.createElement("meta");
    meta.name = "moss-app-preview-origin";
    meta.content = CONTENT_ORIGIN;
    document.head.append(meta);
    const view = {
      page: { id: "page-1" },
      appPreview: CAPABILITY,
    } as unknown as PageGuestView;
    const transport = {
      config: async () => CAPABILITY,
    } as unknown as GuestAppPreviewTransport;

    render(
      <GuestAppItemPreview
        shareId="share-1"
        view={view}
        request={{} as PageGuestViewRequest}
        transport={transport}
        copy={pageGuestCopy("zh-CN")}
      />,
    );

    expect(await screen.findByText("预览不保存数据，5 分钟后失效。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开只读预览" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("也不连接账号");
  });
});
