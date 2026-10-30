import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compactRemotePluginDirectory,
  filterMossManagedCodexModels,
  parseCodexModelListResponse,
  parseCodexPluginListResponse,
  parseCodexPluginReadResponse,
  parseCodexSkillsListResponse,
  withoutShadowedMossSkills,
} from "./codexDiscoveryCatalog.ts";

describe("Codex discovery catalog", () => {
  it("keeps remote directory cards light without touching installed or local plugins", () => {
    const card = {
      displayName: "Plugin",
      shortDescription: "Does things",
      longDescription: "Long",
      developerName: "Dev",
      category: "Travel",
      capabilities: ["Plan"],
      websiteUrl: "https://example.com",
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: ["Go"],
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: "https://example.com/logo.png",
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: ["https://example.com/1.png"],
    };
    const plugin = (name: string, installed: boolean) => ({
      id: `${name}@openai-curated-remote`,
      remotePluginId: null,
      name,
      version: null,
      localVersion: null,
      shareContext: null,
      availability: "AVAILABLE" as const,
      keywords: [],
      source: { type: "remote" as const },
      installed,
      enabled: installed,
      installPolicy: "AVAILABLE" as const,
      installPolicySource: null,
      authPolicy: "ON_INSTALL" as const,
      interface: card,
    });
    const [remote, local] = compactRemotePluginDirectory({
      marketplaces: [
        {
          name: "openai-curated-remote",
          path: null,
          interface: null,
          plugins: [plugin("gmail", true), plugin("tripsy", false)],
        },
        {
          name: "openai-bundled",
          path: "/codex/bundled/marketplace.json",
          interface: null,
          plugins: [plugin("chrome", false)],
        },
      ],
    }).marketplaces;
    const [gmail, tripsy] = remote!.plugins;
    expect(gmail!.interface).toEqual(card);
    expect(tripsy!.interface).toEqual({
      ...card,
      longDescription: null,
      capabilities: [],
      websiteUrl: null,
      defaultPrompt: null,
      screenshotUrls: [],
    });
    expect(local!.plugins[0]!.interface).toEqual(card);
  });

  it("keeps Codex's own skill over Moss's bundled copy of the same name", () => {
    const mossRoot = path.join(path.sep, "home", ".moss", "skills");
    const skill = (name: string, dir: string) => ({
      name,
      path: path.join(dir, name, "SKILL.md"),
      enabled: true,
    });
    const codexSystem = path.join(path.sep, "home", ".codex", "skills", ".system");
    expect(
      withoutShadowedMossSkills(
        [
          skill("skill-creator", codexSystem),
          skill("skill-creator", mossRoot),
          skill("plugin-creator", mossRoot),
        ],
        mossRoot,
      ).map((entry) => entry.path),
    ).toEqual([
      path.join(codexSystem, "skill-creator", "SKILL.md"),
      path.join(mossRoot, "plugin-creator", "SKILL.md"),
    ]);
    expect(withoutShadowedMossSkills([skill("skill-creator", mossRoot)], undefined)).toHaveLength(
      1,
    );
  });

  it("keeps managed Moss Codex discovery closed to Responses-capable source models", () => {
    expect(
      filterMossManagedCodexModels([
        { slug: "gpt-5.6-luna" },
        { slug: "gpt-5.5" },
        { slug: "gpt-5.1" },
        { slug: "deepseek-v4-pro" },
        { slug: "deepseek-v3.2" },
        { slug: "kimi-k3" },
      ]),
    ).toEqual([{ slug: "gpt-5.6-luna" }, { slug: "deepseek-v4-pro" }, { slug: "kimi-k3" }]);
  });

  it("keeps CN managed discovery inside the OpenRouter Codex lineup", () => {
    expect(
      filterMossManagedCodexModels(
        [
          { slug: "gpt-5.6-terra" },
          { slug: "gpt-5.5" },
          { slug: "gpt-5.6-luna" },
          { slug: "deepseek-v4-pro" },
          { slug: "glm-5.3" },
          { slug: "kimi-k3" },
        ],
        { lane: "cn" },
      ),
      // Phone accounts intentionally see only the domestic lineup; foreign
      // vendors need a Google account or an enterprise key.
    ).toEqual([{ slug: "deepseek-v4-pro" }, { slug: "glm-5.3" }, { slug: "kimi-k3" }]);
  });

  it.each([
    {
      responseShape: "camelCase",
      item: {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "low",
        additionalSpeedTiers: ["fast"],
      },
    },
    {
      responseShape: "legacy snake_case",
      item: {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        default_reasoning_effort: "low",
        additional_speed_tiers: ["fast"],
      },
    },
  ])("normalizes $responseShape model/list reasoning efforts", ({ item }) => {
    expect(
      parseCodexModelListResponse({
        result: {
          items: [item],
        },
      }),
    ).toEqual([
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
          { value: "ultra" },
        ],
        defaultReasoningEffort: "low",
        supportsFastMode: true,
      },
    ]);
  });

  it("normalizes bucketed skills/list responses for the requested cwd", () => {
    expect(
      parseCodexSkillsListResponse(
        {
          result: {
            data: [
              {
                cwd: "/other",
                skills: [{ name: "ignore-me", path: "/ignore" }],
              },
              {
                cwd: "/repo",
                skills: [
                  {
                    name: "check-code",
                    description: "Review repo changes for bugs and risks.",
                    path: "/Users/test/.codex/skills/check-code/SKILL.md",
                    scope: "project",
                    interface: {
                      displayName: "Check Code",
                      shortDescription: "Review code changes",
                      iconSmall: null,
                      iconLarge: "/Users/test/.codex/skills/check-code/assets/icon.svg",
                      brandColor: "#0F172A",
                    },
                    dependencies: ["rg"],
                  },
                ],
              },
            ],
          },
        },
        "/repo",
      ),
    ).toEqual([
      {
        name: "check-code",
        description: "Review repo changes for bugs and risks.",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        enabled: true,
        scope: "project",
        interface: {
          displayName: "Check Code",
          shortDescription: "Review code changes",
          // A missing small icon falls back to the large one.
          iconSmall: "/Users/test/.codex/skills/check-code/assets/icon.svg",
          brandColor: "#0F172A",
        },
        dependencies: ["rg"],
      },
    ]);
  });

  it("normalizes plugin/list responses", () => {
    expect(
      parseCodexPluginListResponse({
        result: {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/Users/test/.agents/plugins/marketplace.json",
              interface: {
                displayName: "OpenAI Curated",
              },
              plugins: [
                {
                  id: "plugin/github",
                  name: "github",
                  source: {
                    path: "/Users/test/.codex/plugins/cache/openai-curated/github",
                  },
                  installed: true,
                  enabled: true,
                  installPolicy: "INSTALLED_BY_DEFAULT",
                  authPolicy: "ON_USE",
                  interface: {
                    displayName: "GitHub",
                    shortDescription: "Inspect repositories and pull requests",
                    capabilities: ["pull_requests", "issues"],
                    defaultPrompt: ["Help with repository tasks"],
                    websiteUrl: "https://github.com",
                    screenshots: ["https://example.com/github.png"],
                  },
                },
              ],
            },
          ],
          marketplaceLoadErrors: [
            {
              marketplacePath: "/broken/marketplace.json",
              message: "Invalid marketplace manifest",
            },
          ],
          featuredPluginIds: ["plugin/github"],
          remoteSyncError: "Remote sync unavailable",
        },
      }),
    ).toEqual({
      marketplaces: [
        {
          name: "openai-curated",
          path: "/Users/test/.agents/plugins/marketplace.json",
          interface: {
            displayName: "OpenAI Curated",
          },
          plugins: [
            {
              id: "plugin/github",
              remotePluginId: null,
              name: "github",
              version: null,
              localVersion: null,
              shareContext: null,
              availability: "AVAILABLE",
              keywords: [],
              source: {
                type: "local",
                path: "/Users/test/.codex/plugins/cache/openai-curated/github",
              },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              installPolicySource: null,
              authPolicy: "ON_USE",
              interface: {
                displayName: "GitHub",
                shortDescription: "Inspect repositories and pull requests",
                longDescription: null,
                developerName: null,
                category: null,
                capabilities: ["pull_requests", "issues"],
                defaultPrompt: ["Help with repository tasks"],
                websiteUrl: "https://github.com",
                privacyPolicyUrl: null,
                termsOfServiceUrl: null,
                brandColor: null,
                composerIcon: null,
                composerIconUrl: null,
                logo: null,
                logoDark: null,
                logoUrl: null,
                logoUrlDark: null,
                screenshots: ["https://example.com/github.png"],
                screenshotUrls: [],
              },
            },
          ],
        },
      ],
      marketplaceLoadErrors: [
        {
          marketplacePath: "/broken/marketplace.json",
          message: "Invalid marketplace manifest",
        },
      ],
      featuredPluginIds: ["plugin/github"],
      remoteSyncError: "Remote sync unavailable",
    });
  });

  it("normalizes plugin/read responses into plugin detail", () => {
    expect(
      parseCodexPluginReadResponse({
        result: {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
            summary: {
              id: "plugin/github",
              name: "github",
              source: {
                path: "/Users/test/.codex/plugins/cache/openai-curated/github",
              },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              authPolicy: "ON_USE",
              interface: {
                displayName: "GitHub",
                shortDescription: "Inspect repositories and pull requests",
                longDescription: "Use GitHub tools to work with repositories, issues, and PRs.",
                developerName: "OpenAI",
                category: "Developer Tools",
                capabilities: ["pull_requests", "issues"],
                defaultPrompt: ["Help with repository tasks"],
                websiteUrl: "https://github.com",
                privacyPolicyUrl: "https://github.com/privacy",
                termsOfServiceUrl:
                  "https://docs.github.com/site-policy/github-terms/github-terms-of-service",
                brandColor: "#24292f",
                composerIcon: "github",
                logo: "https://example.com/github-logo.png",
                screenshots: ["https://example.com/github.png"],
              },
            },
            description: "GitHub connector for repository workflows.",
            skills: [
              {
                name: "gh-fix-ci",
                description: "Debug failing GitHub Actions checks.",
                path: "/Users/test/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
                scope: "user",
                dependencies: ["gh"],
              },
            ],
            apps: [
              {
                id: "github-app",
                name: "GitHub App",
                description: "Connected GitHub account",
                installUrl: "https://github.com/apps/openai",
                needsAuth: true,
              },
            ],
            mcpServers: ["GitHub"],
          },
        },
      }),
    ).toEqual({
      marketplaceName: "openai-curated",
      marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
      summary: {
        id: "plugin/github",
        remotePluginId: null,
        name: "github",
        version: null,
        localVersion: null,
        shareContext: null,
        availability: "AVAILABLE",
        keywords: [],
        source: {
          type: "local",
          path: "/Users/test/.codex/plugins/cache/openai-curated/github",
        },
        installed: true,
        enabled: true,
        installPolicy: "INSTALLED_BY_DEFAULT",
        installPolicySource: null,
        authPolicy: "ON_USE",
        interface: {
          displayName: "GitHub",
          shortDescription: "Inspect repositories and pull requests",
          longDescription: "Use GitHub tools to work with repositories, issues, and PRs.",
          developerName: "OpenAI",
          category: "Developer Tools",
          capabilities: ["pull_requests", "issues"],
          defaultPrompt: ["Help with repository tasks"],
          websiteUrl: "https://github.com",
          privacyPolicyUrl: "https://github.com/privacy",
          termsOfServiceUrl:
            "https://docs.github.com/site-policy/github-terms/github-terms-of-service",
          brandColor: "#24292f",
          composerIcon: "github",
          composerIconUrl: null,
          logo: "https://example.com/github-logo.png",
          logoDark: null,
          logoUrl: null,
          logoUrlDark: null,
          screenshots: ["https://example.com/github.png"],
          screenshotUrls: [],
        },
      },
      shareUrl: null,
      description: "GitHub connector for repository workflows.",
      skills: [
        {
          name: "gh-fix-ci",
          description: "Debug failing GitHub Actions checks.",
          path: "/Users/test/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          scope: "user",
          dependencies: ["gh"],
        },
      ],
      hooks: [],
      apps: [
        {
          id: "github-app",
          name: "GitHub App",
          description: "Connected GitHub account",
          installUrl: "https://github.com/apps/openai",
          category: null,
        },
      ],
      appTemplates: [],
      mcpServers: ["GitHub"],
    });
  });
});
