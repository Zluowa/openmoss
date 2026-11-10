import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_MAX_FOLLOW_UP_LENGTH,
  htmlRenderError,
  injectHtmlRenderBootstrap,
  readHtmlRenderFollowUpRequest,
} from "./htmlRender";

const message = (params: unknown, id: string | number = "moss-message-1") => ({
  jsonrpc: "2.0",
  id,
  method: "ui/message",
  params,
});

describe("readHtmlRenderFollowUpRequest", () => {
  it("reads the text blocks of a user message", () => {
    expect(
      readHtmlRenderFollowUpRequest(
        message({
          role: "user",
          content: [
            { type: "text", text: " Recalculate for 6 people " },
            { type: "image", data: "ignored" },
            { type: "text", text: "Tip: 18%" },
          ],
        }),
      ),
    ).toEqual({ id: "moss-message-1", text: "Recalculate for 6 people \nTip: 18%" });
  });

  it("accepts a single content block and a missing role", () => {
    expect(
      readHtmlRenderFollowUpRequest(message({ content: { type: "text", text: "Show Lisbon" } }, 7)),
    ).toEqual({ id: 7, text: "Show Lisbon" });
  });

  it("rejects other roles, empty text, notifications and other methods", () => {
    expect(
      readHtmlRenderFollowUpRequest(
        message({ role: "assistant", content: [{ type: "text", text: "x" }] }),
      ),
    ).toBeUndefined();
    expect(
      readHtmlRenderFollowUpRequest(message({ content: [{ type: "text", text: "   " }] })),
    ).toBeUndefined();
    expect(
      readHtmlRenderFollowUpRequest({
        jsonrpc: "2.0",
        method: "ui/message",
        params: { content: [{ type: "text", text: "no id" }] },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderFollowUpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
  });

  it("caps a long follow-up", () => {
    const text = "a".repeat(HTML_RENDER_MAX_FOLLOW_UP_LENGTH + 50);
    const request = readHtmlRenderFollowUpRequest(message({ content: [{ type: "text", text }] }));
    expect(request?.text).toHaveLength(HTML_RENDER_MAX_FOLLOW_UP_LENGTH);
    expect(request?.text.endsWith("…")).toBe(true);
  });
});

describe("htmlRenderError", () => {
  it("answers a request the client cannot serve", () => {
    expect(htmlRenderError(3, "nope")).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "nope" },
    });
  });
});

describe("follow-up bootstrap", () => {
  it("gives framed pages a helper that posts ui/message", () => {
    const injected = injectHtmlRenderBootstrap(
      "<!doctype html><html><head></head><body></body></html>",
    );
    expect(injected).toContain("window.mossFollowUp=function(t)");
    expect(injected).toContain('method:"ui/message"');
  });
});
