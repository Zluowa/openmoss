// FILE: PluginLibrary.test.tsx
// Purpose: Disabled-provider gating contract for the plugin library catalog.
// Layer: Web component rendering test
// Note: adapted from upstream's PluginLibrary coverage (a9fc80b1d). Moss keeps
// its own render pipeline (effect-based provider fallback, localized empty
// states), so this locks the shared contract at the grid boundary: a provider
// that cannot list plugins renders the unavailable empty state, not content.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { PluginsGrid } from "./PluginLibrary";

function renderUnavailableGrid(providerLabel: string) {
  return renderToStaticMarkup(
    <PluginsGrid
      canListPlugins={false}
      providerLabel={providerLabel}
      isLoading={false}
      error={null}
      queryItemCount={0}
      retrying={false}
      onRetry={() => {}}
      sections={[]}
      hasAny={false}
      activeSearchResultId={null}
      onOpen={() => {}}
      onEnable={() => {}}
      onInstall={() => {}}
      installingPluginKeys={new Set()}
      menuItemsFor={() => []}
    />,
  );
}

it("renders the unavailable empty state instead of catalog content", () => {
  const markup = renderUnavailableGrid("Codex");
  expect(markup).toContain("Plugins unavailable for Codex");
  expect(markup).not.toContain("No plugins found");
});

it("localizes the unavailable empty state", () => {
  localizationTestState.locale = "zh-CN";
  const markup = renderUnavailableGrid("Codex");
  expect(markup).toContain("暂不支持插件");
});
