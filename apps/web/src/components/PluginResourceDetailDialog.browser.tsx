// FILE: PluginResourceDetailDialog.browser.tsx
// Purpose: Locks signed Codex 26.730.61639 plugin-detail geometry and honest row semantics.
// Layer: Browser UI test

import "../index.css";
import "./PluginLibrary.css";

import type { ProviderPluginDescriptor, ProviderPluginDetail } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  PluginResourceDetailDialog,
  PluginResourceDetailPage,
  type ResourceDetail,
} from "./PluginResourceDetailDialog";

const summary = {
  id: "github@curated",
  remotePluginId: null,
  name: "github",
  version: "0.1.8",
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
    displayName: "GitHub",
    shortDescription: "Triage PRs, issues, CI, and publish flows",
    longDescription: null,
    developerName: "OpenAI",
    category: "Developer Tools",
    capabilities: ["Interactive", "Write"],
    websiteUrl: "https://github.com",
    privacyPolicyUrl: null,
    termsOfServiceUrl: null,
    defaultPrompt: [
      "Inspect PRs, triage issues, debug failing checks, and prepare code changes for review",
    ],
    brandColor: "#24292f",
    composerIcon: "./assets/github-composer.svg",
    composerIconUrl: null,
    logo: null,
    logoDark: null,
    logoUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Crect width='60' height='60' fill='%2324292f'/%3E%3C/svg%3E",
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
    "Use GitHub to inspect repositories, review pull requests, address feedback, debug failing Actions checks, and prepare code changes for review through a connector-first workflow with targeted CLI fallbacks.",
  apps: [
    {
      id: "github",
      name: "GitHub",
      description: "Access repositories, issues, and pull requests.",
      installUrl: "https://example.test/install",
      category: "Developer Tools",
    },
    {
      id: "github-enterprise",
      name: "GitHub Enterprise",
      description: "Connect a GitHub Enterprise host.",
      installUrl: null,
      category: "Developer Tools",
    },
  ],
  skills: [
    {
      name: "review-follow-up",
      description: "Address actionable PR feedback",
      path: "/skills/review-follow-up",
      enabled: true,
      interface: { displayName: "Review Follow-up", shortDescription: "Address PR feedback" },
    },
  ],
  hooks: [],
  appTemplates: [],
  mcpServers: [],
} satisfies ProviderPluginDetail;

describe("PluginResourceDetailPage signed geometry", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("preserves the 16px outer and 8px nested inset, typography, radii, and action size", async () => {
    const host = document.createElement("div");
    host.style.width = "1200px";
    host.style.height = "1200px";
    document.body.append(host);
    const screen = await render(
      <PluginResourceDetailPage
        detail={detail}
        onBack={vi.fn()}
        onTryInChat={vi.fn()}
        onInstall={vi.fn()}
        pluginDetail={pluginDetail}
        artworkCwd="/workspace"
      />,
      { container: host },
    );

    try {
      const breadcrumb = page.getByTestId("plugin-detail-breadcrumb").element();
      const content = page.getByTestId("plugin-detail-content").element();
      const header = page.getByTestId("plugin-detail-header").element();
      const artwork = page.getByTestId("plugin-detail-artwork").element();
      const prompt = page.getByTestId("plugin-detail-prompt").element();
      const description = page.getByTestId("plugin-detail-description").element();
      const action = page.getByTestId("plugin-detail-primary-action").element();
      const appsSection = document.querySelector<HTMLElement>(
        '[data-plugin-detail-section="apps"]',
      )!;
      const appRow = document.querySelector<HTMLElement>('[data-testid="plugin-detail-app-row"]')!;

      expect(breadcrumb.getBoundingClientRect().height).toBeCloseTo(46, 3);
      expect(getComputedStyle(breadcrumb.querySelector("button")!).fontSize).toBe("14px");
      expect(getComputedStyle(breadcrumb.querySelector("button")!).fontWeight).toBe("445");
      expect(content.getBoundingClientRect().width).toBeCloseTo(768, 3);
      expect(
        header.getBoundingClientRect().left - content.getBoundingClientRect().left,
      ).toBeCloseTo(16, 3);
      expect(
        artwork.getBoundingClientRect().left - content.getBoundingClientRect().left,
      ).toBeCloseTo(24, 3);
      expect(
        prompt.getBoundingClientRect().left - content.getBoundingClientRect().left,
      ).toBeCloseTo(24, 3);
      expect(prompt.getBoundingClientRect().width).toBeCloseTo(720, 3);
      // The showcase grows with its prompt rows (Codex stacks up to three);
      // a single prompt keeps the signed 122px minimum.
      expect(prompt.getBoundingClientRect().height).toBeGreaterThanOrEqual(122);
      expect(prompt.querySelectorAll("button").length).toBe(summary.interface.defaultPrompt.length);
      expect(getComputedStyle(prompt).borderRadius).toBe("16px");
      expect(appsSection.getBoundingClientRect().left - content.getBoundingClientRect().left).toBe(
        16,
      );
      expect(appRow.getBoundingClientRect().left - content.getBoundingClientRect().left).toBe(24);
      expect(appRow.getBoundingClientRect().width).toBeCloseTo(720, 3);
      expect(getComputedStyle(appRow).paddingTop).toBe("5px");
      expect(getComputedStyle(appRow).borderRadius).toBe("10px");
      expect(appRow.getAttribute("role")).toBeNull();
      expect(appRow.getAttribute("tabindex")).toBeNull();
      expect(getComputedStyle(description).fontSize).toBe("14px");
      expect(getComputedStyle(description).lineHeight).toBe("22.75px");
      // Codex's solid "+ Install plugin" button: 32px tall, 14px medium (Moss 475) text.
      expect(action.getBoundingClientRect().height).toBeCloseTo(32, 3);
      expect(getComputedStyle(action).fontSize).toBe("14px");
      expect(getComputedStyle(action).fontWeight).toBe("475");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("PluginResourceDetailPage Codex parity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the plugin name in the breadcrumb and copies a detail deep link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <PluginResourceDetailPage
        detail={detail}
        onBack={vi.fn()}
        onTryInChat={vi.fn()}
        onInstall={vi.fn()}
        pluginDetail={pluginDetail}
        artworkCwd="/workspace"
      />,
      { container: host },
    );

    try {
      const breadcrumb = page.getByTestId("plugin-detail-breadcrumb").element();
      expect(breadcrumb.textContent).toContain("GitHub");
      expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe("GitHub");

      // Copy link lives in the "…" menu beside the primary action, as in Codex.
      await userEvent.click(page.getByTestId("plugin-detail-more-actions"));
      await userEvent.click(page.getByTestId("plugin-detail-copy-link"));
      await vi.waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          `${window.location.origin}/skills/plugins/${encodeURIComponent(summary.id)}`,
        ),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("stacks up to three suggested prompts and activates the chosen one", async () => {
    const prompts = [
      "Summarize the last 5 messages",
      "Draft a polite reply",
      "Turn the thread into an action tracker",
      "A fourth prompt Codex never renders",
    ];
    const multiPromptSummary: ProviderPluginDescriptor = {
      ...summary,
      interface: { ...summary.interface, defaultPrompt: prompts },
    };
    const onTryInChat = vi.fn();
    const host = document.createElement("div");
    host.style.width = "1200px";
    document.body.append(host);
    const screen = await render(
      <PluginResourceDetailPage
        detail={{ ...detail, plugin: multiPromptSummary }}
        onBack={vi.fn()}
        onTryInChat={onTryInChat}
        pluginDetail={{ ...pluginDetail, summary: multiPromptSummary }}
        artworkCwd="/workspace"
      />,
      { container: host },
    );

    try {
      const showcase = page.getByTestId("plugin-detail-prompt").element();
      const rows = [...showcase.querySelectorAll("button")];
      expect(rows).toHaveLength(3);
      expect(showcase.textContent).not.toContain("fourth prompt");
      rows[1]?.click();
      expect(onTryInChat).toHaveBeenCalledWith(prompts[1]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("PluginResourceDetailDialog skill parity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  const skillDetail = {
    kind: "skill",
    skill: {
      name: "forge",
      description: "Inspect review flows and summarize actionable feedback",
      path: "/skills/forge",
      enabled: true,
      scope: "personal",
      interface: { displayName: "Forge", shortDescription: "Inspect review flows" },
    },
  } satisfies ResourceDetail;

  it("renders Codex skill chrome: title suffix, header switch + overflow, footer actions", async () => {
    const onTryInChat = vi.fn();
    const onUninstall = vi.fn();
    const onToggleEnabled = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <PluginResourceDetailDialog
        detail={skillDetail}
        open
        onOpenChange={vi.fn()}
        canToggle
        onToggleEnabled={onToggleEnabled}
        onTryInChat={onTryInChat}
        onUninstall={onUninstall}
        loadSkillContent={async () => ({
          contents: "---\nname: forge\n---\n# Review workflow\nRead the changes before commenting.",
        })}
      />,
      { container: host },
    );

    try {
      const dialog = page.getByTestId("skill-detail-dialog").element();
      // Title carries the muted "Skill" suffix instead of an uppercase badge.
      const title = dialog.querySelector('[data-slot="dialog-title"]');
      expect(title?.textContent).toContain("Forge");
      expect(title?.textContent).toContain("Skill");
      expect(dialog.querySelector('[data-slot="badge"]')).toBeNull();
      // Header affordances: enable switch + overflow menu.
      expect(dialog.querySelector('[data-slot="switch"]')).not.toBeNull();
      // The browser-suite storage boundary pins direct renders to English.
      expect(dialog.querySelector('button[aria-label="More actions"]')).not.toBeNull();
      // Footer: Uninstall on the left, Try now on the right.
      await userEvent.click(page.getByTestId("skill-detail-try-now"));
      expect(onTryInChat).toHaveBeenCalledTimes(1);
      const uninstall = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Uninstall",
      );
      expect(uninstall).toBeDefined();
      uninstall?.click();
      expect(onUninstall).toHaveBeenCalledTimes(1);
      // Read real instructions, not the catalog description or YAML metadata.
      await expect
        .element(page.getByTestId("skill-detail-body"))
        .toHaveTextContent("Review workflow");
      expect(page.getByTestId("skill-detail-body").element().textContent).not.toContain(
        "name: forge",
      );
      await userEvent.click(page.getByRole("button", { name: "More actions" }));
      await expect.element(page.getByRole("menuitem", { name: "Open", exact: true })).toBeEnabled();
      await expect.element(page.getByRole("menuitem", { name: "Show in folder" })).toBeEnabled();
      await expect.element(page.getByRole("menuitem", { name: "Copy Markdown" })).toBeEnabled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows a failed read and retries without replacing instructions with catalog prose", async () => {
    const loadSkillContent = vi
      .fn()
      .mockRejectedValueOnce(new Error("Skill no longer registered"))
      .mockResolvedValueOnce({ contents: "# Verified instructions\nUse the connected account." });
    const screen = await render(
      <PluginResourceDetailDialog
        detail={skillDetail}
        open
        onOpenChange={vi.fn()}
        loadSkillContent={loadSkillContent}
      />,
    );
    try {
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Couldn't read this skill's instructions.");
      expect(page.getByTestId("skill-detail-body").element().textContent).not.toContain(
        "Inspect review flows",
      );
      await userEvent.click(page.getByRole("button", { name: "Retry" }));
      await expect
        .element(page.getByTestId("skill-detail-body"))
        .toHaveTextContent("Verified instructions");
      expect(loadSkillContent).toHaveBeenCalledTimes(2);
      expect(loadSkillContent).toHaveBeenCalledWith(skillDetail.skill);
    } finally {
      await screen.unmount();
    }
  });
});
