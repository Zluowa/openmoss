// FILE: ProviderUsagePanelContent.test.tsx
// Purpose: Ensures bounded local-archive caveats remain visible beside lower-bound rows.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { translateMoss } from "~/localization";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";

let testLocale: "en" | "zh-CN" = "en";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: testLocale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss(testLocale, key),
      format: vi.fn(),
    }),
  };
});

describe("ProviderUsagePanelContent", () => {
  it("renders the partial-scan notice together with lower-bound archive usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsagePanelContent
        provider="codex"
        rateLimits={[]}
        usageLines={[
          {
            label: "30d",
            value: "≥42 tokens",
            subtitle: "≥1 recent session found",
          },
        ]}
        notice="Local archive totals are lower bounds because the bounded scan was incomplete."
      />,
    );

    expect(markup).toContain("Local archive totals are lower bounds");
    expect(markup).toContain("≥42 tokens");
    expect(markup).toContain("≥1 recent session found");
  });

  it.each(["en", "zh-CN"] as const)(
    "localizes empty, loading, and learn-more copy in %s",
    (locale) => {
      testLocale = locale;
      const loadingMarkup = renderToStaticMarkup(
        <ProviderUsagePanelContent provider="codex" rateLimits={[]} isLoading />,
      );
      const emptyMarkup = renderToStaticMarkup(
        <ProviderUsagePanelContent provider="codex" rateLimits={[]} />,
      );
      const learnMoreMarkup = renderToStaticMarkup(
        <ProviderUsagePanelContent
          provider="codex"
          rateLimits={[]}
          learnMoreHref="https://example.test/usage"
          showLearnMore
        />,
      );

      expect(loadingMarkup).toContain(translateMoss(locale, "settings.usage.scanningLocal"));
      expect(emptyMarkup).toContain(translateMoss(locale, "settings.usage.noLocalData"));
      expect(learnMoreMarkup).toContain(translateMoss(locale, "settings.usage.learnMore"));
    },
  );
});
