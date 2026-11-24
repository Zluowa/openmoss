// FILE: mcpToolResult.browser.tsx
// Purpose: What a person sees when a connector (MCP) tool row opens (L-013): a text result, an
//          image result, a failed call and a cut-short result, in light and dark, Chinese and
//          English. Blocks sit on the shared card, images take the card radius and open on click,
//          an error is one line in the error colour, notes are one muted line; no amber or rose
//          boxes, no card inside a card.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "~/appSettings";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { McpToolResultDetails } from "./McpToolResultDetails";

// The attachment route needs a server; a small picture drawn here stands in for it.
vi.mock("~/lib/wsHttpUrl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/wsHttpUrl")>();
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 80;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#808080";
  context.fillRect(0, 0, 120, 80);
  const picture = canvas.toDataURL("image/png");
  return { ...actual, resolveAttachmentPreviewUrl: () => picture };
});

const CASES = (["light", "dark"] as const).flatMap((theme) =>
  (["zh-CN", "en"] as const).map((locale) => ({ theme, locale })),
);
const px = (value: string) => Number.parseFloat(value);

/** The hue family of a computed colour, to catch Tailwind palette amber or rose. */
function isWarmPalette(color: string): boolean {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return false;
  const [r, g, b] = match.slice(1).map(Number) as [number, number, number];
  return r > 150 && r - b > 60 && g > 90 && g < 200;
}

function result(overrides: Partial<WorkLogMcpToolResult>): WorkLogMcpToolResult {
  return {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-1",
    server: "files",
    tool: "read",
    status: "completed",
    arguments: { path: "notes.md" },
    truncation: { truncated: false, deferredBinary: false },
    ...overrides,
  } as WorkLogMcpToolResult;
}

function Stage(props: { locale: MossLocaleCode; children: React.ReactNode }) {
  return (
    <BrowserThemeFixture>
      <MossLocaleScope locale={props.locale}>
        <div className="w-[640px] bg-background p-6 text-foreground">{props.children}</div>
      </MossLocaleScope>
    </BrowserThemeFixture>
  );
}

function expectStandardCard(card: HTMLElement) {
  const style = getComputedStyle(card);
  expect(px(style.borderTopLeftRadius)).toBe(12);
  expect(px(style.borderTopWidth)).toBe(1);
  expect(style.boxShadow).toBe("none");
  expect(card.parentElement?.closest('[data-slot="card"]')).toBeNull();
}

describe.each(CASES)("connector tool results ($theme, $locale)", ({ theme, locale }) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(900, 900);
  });
  afterEach(() => restoreTheme());

  it("shows a text result and an image result on the shared parts; the image opens on click", async () => {
    const onImageExpand = vi.fn();
    await render(
      <Stage locale={locale}>
        <McpToolResultDetails
          onImageExpand={onImageExpand}
          result={result({
            result: {
              content: [
                { type: "text", text: "第一行\nsecond line" },
                {
                  type: "local_artifact",
                  state: "available",
                  mediaKind: "image",
                  attachmentId: `att_v2_${"0".repeat(32)}`,
                  name: "chart.png",
                  mimeType: "image/png",
                  sizeBytes: 2048,
                  sha256: "0".repeat(64),
                },
              ],
            },
          })}
        />
      </Stage>,
    );
    const root = document.querySelector<HTMLElement>("[data-mcp-tool-result-details]")!;
    const cards = root.querySelectorAll<HTMLElement>('[data-slot="card"]');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expectStandardCard(card);
    const text = root.querySelector<HTMLElement>('[data-mcp-content-type="text"]')!;
    expect(px(getComputedStyle(text).fontSize)).toBe(14);
    expect(text.closest('[data-slot="card"]')).not.toBeNull();

    const image = root.querySelector<HTMLImageElement>('[data-mcp-media-kind="image"] img')!;
    await expect.poll(() => image.complete && image.naturalWidth > 0).toBe(true);
    expect(px(getComputedStyle(image).borderTopLeftRadius)).toBe(12);
    expect(image.getBoundingClientRect().height).toBeLessThanOrEqual(192);
    await userEvent.click(page.elementLocator(image));
    expect(onImageExpand).toHaveBeenCalledTimes(1);
    expect(root.querySelector("[title]")).toBeNull();
  });

  it("shows a failed call as one line in the error colour and a cut-short result as one muted note", async () => {
    await render(
      <Stage locale={locale}>
        <span data-testid="muted" className="text-muted-foreground">
          muted
        </span>
        <span data-testid="danger" className="text-destructive">
          danger
        </span>
        <McpToolResultDetails
          result={result({
            status: "failed",
            error: { message: "permission denied: notes.md" },
            truncation: { truncated: true, deferredBinary: false, omittedBlocks: 2 },
          })}
        />
      </Stage>,
    );
    const root = document.querySelector<HTMLElement>("[data-mcp-tool-result-details]")!;
    const error = root.querySelector<HTMLElement>("[data-mcp-error]")!;
    expect(error.textContent).toContain("permission denied: notes.md");
    // One line, no box: no border, no fill, the error colour, 13 px.
    expect(px(getComputedStyle(error).borderTopWidth)).toBe(0);
    expect(getComputedStyle(error).backgroundColor).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(getComputedStyle(error).color).toBe(
      getComputedStyle(document.querySelector('[data-testid="danger"]')!).color,
    );
    expect(px(getComputedStyle(error).fontSize)).toBe(13);
    const note = root.querySelector<HTMLElement>('[data-mcp-state="truncated"]')!;
    expect(px(getComputedStyle(note).borderTopWidth)).toBe(0);
    expect(getComputedStyle(note).color).toBe(
      getComputedStyle(document.querySelector('[data-testid="muted"]')!).color,
    );
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      expect(isWarmPalette(getComputedStyle(element).backgroundColor)).toBe(false);
    }
  });
});
