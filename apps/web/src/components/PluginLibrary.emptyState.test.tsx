// FILE: PluginLibrary.emptyState.test.tsx
// Purpose: Locks the frozen Codex 26.730.61639 browse/search empty-state DOM and copy.
// Layer: Web component rendering test

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

vi.mock("../localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization")>();
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

import { PluginBrowseEmptyState, PluginsGrid } from "./PluginLibrary";
import { PluginLibraryHeader } from "./PluginLibraryPrimitives";

beforeEach(() => {
  localizationTestState.locale = "en";
});

describe("PluginBrowseEmptyState", () => {
  it.each([
    { locale: "en" as const, copy: "No plugins found" },
    { locale: "zh-CN" as const, copy: "未找到插件" },
  ])("matches the frozen Codex browse/search empty state in $locale", ({ locale, copy }) => {
    localizationTestState.locale = locale;

    expect(renderToStaticMarkup(<PluginBrowseEmptyState />)).toBe(
      `<div role="status" aria-live="polite" class="text-base text-token-text-secondary">${copy}</div>`,
    );
  });

  it("is the visible browse result when a populated directory has no search matches", () => {
    expect(
      renderToStaticMarkup(
        <PluginsGrid
          canListPlugins
          providerLabel="Codex"
          isLoading={false}
          error={null}
          queryItemCount={1}
          retrying={false}
          onRetry={vi.fn()}
          sections={[]}
          hasAny={false}
          activeSearchResultId={null}
          onOpen={vi.fn()}
          onEnable={vi.fn()}
          onInstall={vi.fn()}
          installingPluginKeys={new Set()}
          menuItemsFor={() => []}
        />,
      ),
    ).toBe(
      '<div role="status" aria-live="polite" class="text-base text-token-text-secondary">No plugins found</div>',
    );
  });

  it("maps the frozen utility names to the frozen 14px/21px secondary-text presentation", () => {
    const css = readFileSync(new URL("./PluginLibrary.css", import.meta.url), "utf8");

    expect(css).toContain(`.text-token-text-secondary {
  color: var(--color-token-text-secondary);
}`);
    expect(css).toContain(`.text-base.text-token-text-secondary {
  font-size: 14px;
  line-height: 21px;
}`);
  });

  it("renders the header actions for hosts that keep them in the top bar", () => {
    const markup = renderToStaticMarkup(
      <PluginLibraryHeader
        mode="manage"
        selectedTab="plugins"
        labels={{
          browseAria: "Browse plugins or skills",
          plugins: "Plugins",
          skills: "Skills",
          manage: "Manage",
          refresh: "Refresh",
          create: "Create",
          createPlugin: "Create plugin",
          importPluginsAndSkills: "Import plugins and skills",
          createSkill: "Create skill",
          recordSkill: "Record a skill",
          addMarketplace: "Add marketplace",
          requestPlugin: "Request a plugin",
        }}
        onTabChange={vi.fn()}
        onExitManage={vi.fn()}
        onRefresh={vi.fn()}
        onCreatePlugin={vi.fn()}
        onImportPluginsAndSkills={vi.fn()}
        onCreateSkill={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Refresh"');
    // With Create plugin as the only manage action, Add runs it directly (Codex).
    expect(markup).toContain('title="Create plugin"');
    expect(markup).toContain(">Create</button>");

    // Codex puts Browse catalog / Add beside the Settings page title and the
    // browse toolbar beside the page title, so the shell's top bar stays bare.
    const source = readFileSync(new URL("./PluginLibrary.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/hideActions\s*\/>/);
    expect(source).toContain("<PluginLibraryAddMenu");
  });
});
