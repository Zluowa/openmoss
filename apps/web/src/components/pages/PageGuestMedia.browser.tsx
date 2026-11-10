import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PageId, type PageGuestView } from "@moss/contracts";

import { PageRichView } from "~/guest/pages/PageRichView";
import { PageGuestApp } from "~/guest/pages/PageGuestApp";
import type { PageGuestTransport } from "~/guest/pages/pageGuestTransport";
import { MossLocaleScope } from "~/localization";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const blob = () =>
  new Blob([Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0))], {
    type: "image/png",
  });
const document = JSON.stringify([
  {
    type: "img",
    url: "/api/library-image/lib-included",
    alt: "Shared picture",
    children: [{ text: "" }],
  },
  {
    type: "img",
    url: "https://outside.invalid/private.png",
    alt: "External picture",
    children: [{ text: "" }],
  },
  { type: "video", url: "/api/library-image/lib-video", alt: "Video", children: [{ text: "" }] },
]);

describe("guest page images", () => {
  it.each([true, false])(
    "requests images only when the owner advertises support: %s",
    async (supported) => {
      const pageId = PageId.makeUnsafe("page-fixture");
      const view: PageGuestView = {
        mode: "site",
        title: "Shared site",
        role: "view",
        viewerName: null,
        pages: [{ id: pageId, title: "Picture page", parentId: null }],
        page: {
          id: pageId,
          title: "Picture page",
          kind: "page",
          revision: 3,
          updatedAt: "2026-11-06T00:00:00.000Z",
          content: "",
          richContent: document,
        },
        canComment: false,
        ...(supported ? { canLoadImages: true } : {}),
      };
      const media = vi.fn<PageGuestTransport["media"]>(async () => ({ ok: true, value: blob() }));
      const transport: PageGuestTransport = {
        view: async () => ({ ok: true, value: view }),
        media,
        comments: async () => ({ ok: true, value: { comments: [] } }),
        access: async () => ({ ok: false, failure: { kind: "refused", reason: "forbidden" } }),
      };
      const mounted = await render(
        <MossLocaleScope locale="en">
          <PageGuestApp
            entry={{ shareId: "fixture", link: null, key: "fixture-key" }}
            transport={transport}
          />
        </MossLocaleScope>,
      );
      try {
        await expect.element(page.getByRole("heading", { name: "Picture page" })).toBeVisible();
        if (supported) {
          await expect.element(page.getByRole("img", { name: "Shared picture" })).toBeVisible();
          expect(media).toHaveBeenCalledWith(
            expect.objectContaining({
              pageId,
              revision: 3,
              itemId: "lib-included",
              key: "fixture-key",
            }),
          );
        } else {
          await expect.element(page.getByText("Shared picture", { exact: true })).toBeVisible();
          expect(media).not.toHaveBeenCalled();
        }
      } finally {
        await mounted.unmount();
      }
    },
  );

  it("loads only authorized library images and releases their blob URLs when leaving the page", async () => {
    const load = vi.fn(async () => blob());
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const mounted = await render(
      <PageRichView
        richContent={document}
        content=""
        imageLabel="Image"
        imageNotShared="Preview unavailable"
        loadImage={load}
      />,
    );
    try {
      await expect.element(page.getByRole("img", { name: "Shared picture" })).toBeVisible();
      expect(load.mock.calls).toEqual([["lib-included"]]);
      await expect.element(page.getByText("External picture")).toBeVisible();
      await expect.element(page.getByText("Video", { exact: true })).toBeVisible();
      expect(globalThis.document.querySelectorAll("img")).toHaveLength(1);
      expect(globalThis.document.querySelector("img")!.src).toMatch(/^blob:/);
    } finally {
      await mounted.unmount();
      expect(revoke).toHaveBeenCalledOnce();
      revoke.mockRestore();
    }
  });

  it("keeps unavailable images as placeholders and never uses their owner URL directly", async () => {
    const mounted = await render(
      <PageRichView
        richContent={document}
        content=""
        imageLabel="Image"
        imageNotShared="Preview unavailable"
        loadImage={async () => null}
      />,
    );
    try {
      await expect.element(page.getByText("Shared picture · Preview unavailable")).toBeVisible();
      expect(globalThis.document.querySelector("img")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
