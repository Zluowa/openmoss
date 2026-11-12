// FILE: ComposerQuoteRows.test.tsx
// Purpose: Guards the composer's quote rows: one row per quote, the passage on one line in
//   quotation marks, "With reply" only for quotes the reader replied to, a labelled remove.
// Layer: Component rendering tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "~/localization";
import { ComposerQuoteRows } from "./ComposerQuoteRows";

const quote = (id: string, text: string, comment?: string) => ({
  type: "assistant-selection" as const,
  id,
  assistantMessageId: "assistant-1",
  text,
  ...(comment ? { comment } : {}),
});

describe("ComposerQuoteRows", () => {
  it("renders one row per quote with the passage on one line", () => {
    const markup = renderToStaticMarkup(
      <ComposerQuoteRows
        selections={[quote("a", "first line\n\nsecond line"), quote("b", "another passage")]}
        onRemove={() => {}}
      />,
    );
    expect(markup.match(/data-composer-quote-row="true"/g)).toHaveLength(2);
    expect(markup).toContain("first line second line");
    expect(markup).toContain("“");
    expect(markup).toContain("”");
    expect(markup.match(/aria-label="Remove quote"/g)).toHaveLength(2);
    expect(markup).not.toContain("With reply");
  });

  it("marks a quote that carries the reader's reply", () => {
    const markup = renderToStaticMarkup(
      <ComposerQuoteRows selections={[quote("a", "a passage", "my reply")]} />,
    );
    expect(markup).toContain("With reply");
    expect(markup).not.toContain('aria-label="Remove quote"');
  });

  it("speaks Chinese in the Chinese locale", () => {
    const markup = renderToStaticMarkup(
      <MossLocaleScope locale="zh-CN">
        <ComposerQuoteRows selections={[quote("a", "一段文字", "我的回复")]} onRemove={() => {}} />
      </MossLocaleScope>,
    );
    expect(markup).toContain("附带回复");
    expect(markup).toContain('aria-label="移除引用"');
  });

  it("renders nothing without quotes", () => {
    expect(renderToStaticMarkup(<ComposerQuoteRows selections={[]} />)).toBe("");
  });
});
