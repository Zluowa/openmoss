// FILE: ReadonlyAppItemFrame.browser.tsx
// Purpose: Exercise the actual static host, production CSP and owner/guest adapters.
// Layer: Browser fixtures; guest authorization transport is deliberately not connected

import "../../../index.css";

import type { ReadonlyAppItemContext } from "@moss/shared/readonlyAppItem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";

import { AppItemView } from "./AppItemView";
import { ReadonlyAppItemFrame } from "./ReadonlyAppItemFrame";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    writeReadonlyAppItemEvidence: () => Promise<{ width: number; height: number }>;
  }
}

const title = "Readonly fixture";
const script = (
  label: string,
) => `<!doctype html><html><head></head><body><h1>${label}</h1><script>(async function(){
  let parentBlocked=false,cookieBlocked=false,fetchBlocked=false;
  try{void parent.document.body;}catch(_){parentBlocked=true;}
  try{void document.cookie;}catch(_){cookieBlocked=true;}
  try{await fetch(location.origin+"/api/page-apps/list");}catch(_){fetchBlocked=true;}
  const capabilities=await Promise.all(["db","ai","downloads","user","permissions","page","room","connectors"].map(name=>moss.use(name)));
  parent.postMessage({kind:"readonly-fixture",label:${JSON.stringify(label)},parentBlocked,cookieBlocked,fetchBlocked,capabilities,grantLeaked:location.href.includes("private-grant-fixture")},${JSON.stringify(window.location.origin)});
})();</script></body></html>`;

function context(
  html: string,
  audience: "owner" | "guest" | "template" = "guest",
  revision = 1,
): ReadonlyAppItemContext {
  const publicMetadata = { title, revision };
  if (audience === "template")
    return {
      audience,
      document: {
        html,
        source: { sourceKind: "template-preview", templateId: "template-fixture" },
        publicMetadata: { title, revision: null },
      },
    };
  const document = {
    html,
    source: {
      sourceKind: "page-item" as const,
      pageId: "typed-page-fixture",
      pageRevision: revision,
      dataRevision: revision,
    },
    publicMetadata,
  };
  return audience === "owner"
    ? { audience, document }
    : {
        audience,
        document,
        grantId: "private-grant-fixture",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
}

beforeEach(async () => {
  await page.viewport(1000, 700);
});
afterEach(async () => {
  await commands.endAppThumbnailRequestProbe();
});

describe("readonly AppItem rendering", () => {
  it.each(["owner", "guest", "template"] as const)(
    "executes %s HTML with no capabilities, parent access or network",
    async (audience) => {
      await commands.beginAppThumbnailRequestProbe(title, true);
      let received: unknown;
      let origin = "";
      const observe = (event: MessageEvent) => {
        if (event.data?.kind === "readonly-fixture") {
          received = event.data;
          origin = event.origin;
        }
      };
      window.addEventListener("message", observe);
      const html = script("Coral preview");
      const mounted = await render(
        <MossLocaleScope locale="zh-CN">
          <div style={{ width: 800, height: 440, display: "flex" }}>
            {audience === "owner" ? (
              <AppItemView
                pageId="typed-page-fixture"
                revision={1}
                dataRevision={1}
                title={title}
                data={JSON.stringify({ version: 1, html, capabilities: ["db", "user"] })}
              />
            ) : (
              <ReadonlyAppItemFrame context={context(html, audience)} />
            )}
          </div>
        </MossLocaleScope>,
      );
      try {
        await vi.waitFor(
          () =>
            expect(received).toEqual({
              kind: "readonly-fixture",
              label: "Coral preview",
              parentBlocked: true,
              cookieBlocked: true,
              fetchBlocked: true,
              capabilities: Array(8).fill(null),
              grantLeaked: false,
            }),
          { timeout: 3_000 },
        );
        expect(origin).toBe("null");
        expect(
          document.querySelector("[data-readonly-app-item]")?.getAttribute("data-frame-status"),
        ).toBe("ready");
        expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
        if (audience === "owner")
          expect(await commands.writeReadonlyAppItemEvidence()).toEqual({
            width: 800,
            height: 440,
          });
      } finally {
        window.removeEventListener("message", observe);
        await mounted.unmount();
      }
    },
  );

  it("reopens equal-length content edits, then clears the old frame on page switch and unmount", async () => {
    await commands.beginAppThumbnailRequestProbe(title, true);
    const seen: string[] = [];
    const observe = (event: MessageEvent) => {
      if (event.data?.kind === "readonly-fixture") seen.push(event.data.label);
    };
    window.addEventListener("message", observe);
    const one = script("First");
    const two = script("Later");
    expect(one.length).toBe(two.length);
    const mounted = await render(<ReadonlyAppItemFrame context={context(one, "owner")} />);
    let unmounted = false;
    try {
      await vi.waitFor(() => expect(seen).toEqual(["First"]), { timeout: 3_000 });
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`)!;
      const oldUrl = frame.src;
      await mounted.rerender(<ReadonlyAppItemFrame context={context(two, "owner")} />);
      await vi.waitFor(() => expect(seen).toEqual(["First", "Later"]), { timeout: 3_000 });
      expect(frame.src).not.toBe(oldUrl);
      const next = context(two, "owner", 2);
      await mounted.rerender(<ReadonlyAppItemFrame context={next} />);
      await vi.waitFor(() => expect(seen).toEqual(["First", "Later", "Later"]), { timeout: 3_000 });
      if (next.audience !== "owner") throw new Error("Invalid owner fixture");
      await mounted.rerender(
        <ReadonlyAppItemFrame
          context={{
            ...next,
            document: {
              ...next.document,
              source: { ...next.document.source, pageId: "another-page" },
            },
          }}
        />,
      );
      await vi.waitFor(() => expect(seen).toEqual(["First", "Later", "Later", "Later"]), {
        timeout: 3_000,
      });
      await mounted.unmount();
      unmounted = true;
      expect(frame.src).toBe("about:blank");
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
    } finally {
      window.removeEventListener("message", observe);
      if (!unmounted) await mounted.unmount();
    }
  });

  it("clears a live guest frame when its grant expires", async () => {
    await commands.beginAppThumbnailRequestProbe(title, true);
    const guest = context(script("Expiry"), "guest");
    if (guest.audience !== "guest") throw new Error("Invalid fixture");
    const mounted = await render(
      <ReadonlyAppItemFrame
        context={{ ...guest, expiresAt: new Date(Date.now() + 800).toISOString() }}
      />,
    );
    try {
      await vi.waitFor(
        () =>
          expect(
            document.querySelector("[data-readonly-app-item]")?.getAttribute("data-frame-status"),
          ).toBe("ready"),
        { timeout: 600 },
      );
      await vi.waitFor(
        () =>
          expect(
            document.querySelector("[data-readonly-app-item]")?.getAttribute("data-frame-status"),
          ).toBe("expired"),
        { timeout: 1_200 },
      );
      expect(document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`)?.src).toBe(
        "about:blank",
      );
      await mounted.rerender(
        <ReadonlyAppItemFrame
          context={{
            ...guest,
            grantId: "renewed-fixture",
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          }}
        />,
      );
      await vi.waitFor(
        () =>
          expect(
            document.querySelector("[data-readonly-app-item]")?.getAttribute("data-frame-status"),
          ).toBe("ready"),
        { timeout: 1_000 },
      );
      expect(await commands.endAppThumbnailRequestProbe()).toEqual([]);
    } finally {
      await mounted.unmount();
    }
  });

  it.each(["en", "zh-CN"] as const)(
    "shows preview status in the selected %s locale",
    async (locale) => {
      const guest = context("<p>Expired</p>", "guest");
      if (guest.audience !== "guest") throw new Error("Invalid guest fixture");
      const mounted = await render(
        <MossLocaleScope locale={locale}>
          <ReadonlyAppItemFrame context={{ ...guest, expiresAt: new Date(0).toISOString() }} />
        </MossLocaleScope>,
      );
      try {
        await expect
          .element(page.getByRole("status"))
          .toHaveTextContent(
            locale === "en"
              ? "Preview access expired. Please reopen it."
              : "预览授权已过期，请重新打开。",
          );
      } finally {
        await mounted.unmount();
      }
    },
  );
});
