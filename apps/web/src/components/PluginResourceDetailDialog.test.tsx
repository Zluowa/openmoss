// FILE: PluginResourceDetailDialog.test.tsx
// Purpose: Locks the plugin-detail hierarchy and loading boundary.
// Layer: Web component rendering test

import type { ProviderPluginDescriptor, ProviderPluginDetail } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope } from "../localization";
import type { MossLocaleCode } from "../uiLocale";
import { PluginResourceDetailPage, type ResourceDetail } from "./PluginResourceDetailDialog";

const summary = {
  id: "forge-suite@curated",
  remotePluginId: null,
  name: "forge-suite",
  version: "1.2.3",
  localVersion: null,
  shareContext: null,
  availability: "AVAILABLE",
  keywords: ["development"],
  source: { type: "remote" },
  installed: false,
  enabled: false,
  installPolicy: "AVAILABLE",
  installPolicySource: null,
  authPolicy: "ON_USE",
  interface: {
    displayName: "Forge Suite",
    shortDescription: "Triage reviews, checks, and release flows",
    longDescription: null,
    developerName: "Acme",
    category: "Developer Tools",
    capabilities: ["Interactive", "Write"],
    websiteUrl: "https://example.com/forge",
    privacyPolicyUrl: "https://example.com/privacy",
    termsOfServiceUrl: "https://example.com/terms",
    defaultPrompt: [
      "Inspect reviews, triage issues, debug failing checks, and prepare changes for review",
    ],
    brandColor: "#24292f",
    composerIcon: null,
    composerIconUrl: null,
    logo: null,
    logoDark: null,
    logoUrl: "/tmp/forge.png",
    logoUrlDark: null,
    screenshots: [],
    screenshotUrls: [],
  },
} satisfies ProviderPluginDescriptor;

const detail = {
  kind: "plugin",
  plugin: summary,
  marketplaceName: "curated",
  marketplacePath: null,
  remoteMarketplaceName: "curated",
} satisfies ResourceDetail;

const pluginDetail = {
  marketplaceName: "curated",
  marketplacePath: null,
  summary,
  shareUrl: null,
  description:
    "Use Forge Suite to inspect repositories, review changes, address feedback, debug failing checks, and prepare changes for review.",
  apps: [
    {
      id: "connector/forge",
      name: "Forge",
      description: "Access repositories, issues, and review requests.",
      installUrl: "https://example.com/install",
      category: "Developer Tools",
    },
    {
      id: "connector/forge-enterprise",
      name: "Forge Enterprise",
      description: "Workspace-specific connector for an enterprise host.",
      installUrl: null,
      category: "Developer Tools",
    },
  ],
  skills: [
    {
      name: "review-follow-up",
      description: "Address actionable review feedback",
      path: "/skills/review-follow-up",
      enabled: true,
      interface: { displayName: "Review Follow-up", shortDescription: "Address feedback" },
    },
    {
      name: "ci-debug",
      description: "Debug failing automation checks",
      path: "/skills/ci-debug",
      enabled: true,
      interface: { displayName: "CI Debug", shortDescription: "Debug checks" },
    },
    {
      name: "forge",
      description: "Inspect reviews, issues, CI, and publish flows",
      path: "/skills/forge",
      enabled: true,
      interface: { displayName: "Forge", shortDescription: "Inspect review flows" },
    },
    {
      name: "publish-changes",
      description: "Commit, push, and open a review request",
      path: "/skills/publish-changes",
      enabled: true,
      interface: { displayName: "Publish Changes", shortDescription: "Publish changes" },
    },
  ],
  hooks: [],
  appTemplates: [],
  mcpServers: [],
} satisfies ProviderPluginDetail;

function renderPage(input?: {
  readonly pluginDetail?: ProviderPluginDetail | undefined;
  readonly loading?: boolean | undefined;
  readonly detail?: ResourceDetail | undefined;
  readonly locale?: MossLocaleCode | undefined;
}) {
  return renderToStaticMarkup(
    <MossLocaleScope locale={input?.locale ?? "en"}>
      <PluginResourceDetailPage
        detail={input?.detail ?? detail}
        onBack={vi.fn()}
        onTryInChat={vi.fn()}
        onInstall={vi.fn()}
        onManage={vi.fn()}
        pluginDetail={input?.pluginDetail}
        pluginDetailLoading={input?.loading}
        artworkCwd="/workspace"
      />
    </MossLocaleScope>,
  );
}

describe("PluginResourceDetailPage", () => {
  it("renders the signed-Codex detail hierarchy from generic plugin, app, and skill data", () => {
    const markup = renderPage({ pluginDetail });

    expect(markup).toContain('data-plugin-detail-state="settled"');
    expect(markup).toContain('data-testid="plugin-detail-breadcrumb"');
    expect(markup).toContain("h-[46px]");
    expect(markup).toContain("text-ui-lg");
    expect(markup).toContain("font-[445]");
    expect(markup).toContain('data-testid="plugin-detail-content"');
    expect(markup).toContain('class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4');
    expect(markup).toContain('data-testid="plugin-detail-header"');
    expect(markup).toContain('class="flex flex-col gap-4 px-2"');
    expect(markup).toContain('data-testid="plugin-detail-artwork"');
    expect(markup).toContain('class="min-w-0 break-words text-[22px] leading-7 font-semibold');
    // Codex: "By {developer}" under the name, then "…" and a solid Install button.
    expect(markup).toContain('data-testid="plugin-detail-developer"');
    expect(markup).toContain('data-testid="plugin-detail-more-actions"');
    expect(markup).toContain('data-testid="plugin-detail-primary-action"');
    expect(markup).toContain("h-8 gap-1.5 rounded-lg px-3");
    expect(markup).toContain("rounded-control");
    expect(markup).toContain("leading-[18px]");
    expect(markup).toContain('data-testid="plugin-detail-prompt"');
    expect(markup).toContain("mx-2");
    expect(markup).toContain("min-h-[122px]");
    expect(markup).toContain("rounded-panel");
    expect(markup).toContain('data-testid="plugin-detail-description"');
    expect(markup).toContain("leading-[22.75px]");
    expect(markup).toContain('data-plugin-detail-section="apps"');
    expect(markup).toContain('data-plugin-detail-section="skills"');
    expect(markup).toContain('data-plugin-detail-section="information"');

    const promptIndex = markup.indexOf('data-testid="plugin-detail-prompt"');
    const longDescriptionIndex = markup.indexOf(pluginDetail.description);
    const appsIndex = markup.indexOf('data-plugin-detail-section="apps"');
    const skillsIndex = markup.indexOf('data-plugin-detail-section="skills"');
    const informationIndex = markup.indexOf('data-plugin-detail-section="information"');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(longDescriptionIndex);
    expect(longDescriptionIndex).toBeLessThan(appsIndex);
    expect(appsIndex).toBeLessThan(skillsIndex);
    expect(skillsIndex).toBeLessThan(informationIndex);

    expect(markup).toContain('data-plugin-detail-count="apps">2</span>');
    expect(markup).toContain('data-plugin-detail-count="skills">4</span>');
    expect(markup).toContain("Forge Enterprise");
    expect(markup).toContain('data-plugin-app-install-target="missing"');
    expect(markup).not.toContain("data-plugin-app-availability");
    expect(markup).not.toContain('aria-label="Disabled by admin"');
    expect(markup).toContain("Review Follow-up");
    expect(markup).toContain("Publish Changes");
    expect(markup).not.toContain('data-plugin-detail-section="includes"');
    expect(markup).toContain('data-testid="plugin-detail-app-row"');
    expect(markup).toContain('data-testid="plugin-detail-skill-row"');
    expect(markup).not.toContain('data-plugin-resource-row-role="button"');

    expect(markup).toContain("Forge Suite</span>");
    expect(markup).toContain(
      "Inspect reviews, triage issues, debug failing checks, and prepare changes for review",
    );
    expect(markup).toContain("path=%2Ftmp%2Fforge.png");
    expect(markup).toContain("cwd=%2Fworkspace");
    expect(markup).not.toContain('src="/tmp/forge.png"');
  });

  it("lists only Codex's information rows and the data-sharing note", () => {
    const markup = renderPage({ pluginDetail, locale: "zh-CN" });

    for (const label of ["功能", "开发者", "分类", "版本", "网站", "隐私政策", "服务条款"]) {
      expect(markup).toContain(`>${label}</dt>`);
    }
    for (const internal of ["安装策略", "认证策略", ">许可<"]) {
      expect(markup).not.toContain(internal);
    }
    expect(markup).toContain('data-testid="plugin-detail-legal-notice"');
    expect(markup).toContain("使用 Forge Suite 时，Moss 会把完成请求所需的对话内容发送给");
  });

  it("resolves local composer and dark artwork fallbacks through the authenticated image route", () => {
    const localComposerSummary: ProviderPluginDescriptor = {
      ...summary,
      interface: {
        ...summary.interface,
        composerIcon: "./assets/composer.svg",
        logoUrl: null,
        logo: null,
        logoUrlDark: "./assets/dark-logo.svg",
      },
    };
    const localComposerDetail: ResourceDetail = {
      ...detail,
      plugin: localComposerSummary,
    };
    const composerMarkup = renderPage({
      detail: localComposerDetail,
      pluginDetail: { ...pluginDetail, summary: localComposerSummary },
    });
    expect(composerMarkup).toContain("path=.%2Fassets%2Fcomposer.svg");
    expect(composerMarkup).toContain("cwd=%2Fworkspace");

    const darkSummary: ProviderPluginDescriptor = {
      ...localComposerSummary,
      interface: {
        ...summary.interface,
        composerIcon: null,
        logo: null,
        logoUrl: null,
        logoUrlDark: null,
        logoDark: "./assets/dark-local.svg",
      },
    };
    const darkMarkup = renderPage({
      detail: { ...detail, plugin: darkSummary },
      pluginDetail: { ...pluginDetail, summary: darkSummary },
    });
    expect(darkMarkup).toContain("path=.%2Fassets%2Fdark-local.svg");
    expect(darkMarkup).not.toContain('src="./assets/dark-local.svg"');
  });

  it("keeps an unresolved detail read visibly loading instead of rendering final sections", () => {
    const markup = renderPage({ loading: true });

    expect(markup).toContain('data-plugin-detail-state="loading"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('data-plugin-detail-section="apps"');
    expect(markup).not.toContain('data-plugin-detail-section="skills"');
    expect(markup).not.toContain('data-plugin-detail-section="information"');
  });
});
