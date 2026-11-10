import { describe, expect, it } from "vitest";
import { composerCommandMenuKeyHints, type ComposerCommandItem } from "./ComposerCommandMenu";
import { groupCommandItems, orderSlashCommandItemsByGroup } from "./composerCommandGroups";

describe("groupCommandItems", () => {
  it("groups mention suggestions as plugins, chats, local, then subagents", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "agent:codex:mini",
        type: "agent",
        provider: "codex",
        alias: "mini",
        color: "violet",
        label: "@mini",
        description: "GPT-5.4 Mini",
      },
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "plugin:github",
        type: "plugin",
        plugin: {
          id: "plugin/github",
          remotePluginId: null,
          version: null,
          localVersion: null,
          name: "GitHub",
          shareContext: null,
          source: {
            type: "local",
            path: "/test/plugins/github",
          },
          interface: {
            displayName: "GitHub",
            shortDescription: "Triage PRs and CI",
            longDescription: null,
            developerName: null,
            category: null,
            capabilities: [],
            websiteUrl: null,
            privacyPolicyUrl: null,
            termsOfServiceUrl: null,
            defaultPrompt: null,
            brandColor: null,
            composerIcon: null,
            composerIconUrl: null,
            logo: null,
            logoDark: null,
            logoUrl: null,
            logoUrlDark: null,
            screenshots: [],
            screenshotUrls: [],
          },
          installed: true,
          enabled: true,
          installPolicy: "AVAILABLE",
          installPolicySource: null,
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          keywords: [],
        },
        mention: {
          name: "GitHub",
          path: "plugin://GitHub@codex",
        },
        label: "GitHub",
        description: "Triage PRs and CI",
      },
      {
        id: "local-root",
        type: "local-root",
        label: "@local",
        description: "Browse folders on this computer",
      },
      {
        id: "thread:thread-1",
        type: "thread",
        threadId: "thread-1",
        provider: "codex",
        mention: { name: "Release prep", path: "thread://thread-1" },
        label: "Release prep",
        description: "Moss",
      },
    ];

    expect(groupCommandItems(items, "mention", true)).toEqual([
      {
        id: "plugins",
        label: "Plugins",
        items: [items[2]],
      },
      {
        id: "chats",
        label: "Chats",
        items: [items[4]],
      },
      {
        id: "local",
        label: "Local",
        items: [items[1], items[3]],
      },
      {
        id: "subagents",
        label: "Subagents",
        items: [items[0]],
      },
    ]);
  });
});

describe("groupCommandItems connectors", () => {
  it("puts connectors in their own first group", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "path:file:/workspace/AGENTS.md",
        type: "path",
        path: "/workspace/AGENTS.md",
        pathKind: "file",
        label: "AGENTS.md",
        description: "/workspace",
      },
      {
        id: "connector:mcp_conn_1",
        type: "connector",
        connectorName: "Supabase",
        mention: { name: "Supabase", path: "connector://supabase_connector" },
        label: "Supabase",
        description: "mcp.supabase.com",
      },
    ];

    expect(
      groupCommandItems(items, "mention", false).map((group) => [
        group.label,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["Connectors", ["connector:mcp_conn_1"]],
      ["Local", ["path:file:/workspace/AGENTS.md"]],
    ]);
  });
});

describe("groupCommandItems slash sections", () => {
  const appCommand: ComposerCommandItem = {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
    source: "shared",
  };
  const claudeCommand: ComposerCommandItem = {
    id: "provider-command:claudeAgent:compact",
    type: "provider-native-command",
    provider: "claudeAgent",
    command: "compact",
    label: "/compact",
    description: "Summarize the conversation and reduce context usage",
  };
  const skill: ComposerCommandItem = {
    id: "skill:/skills/dataviz",
    type: "skill",
    skill: {
      name: "dataviz",
      description: "Charts",
      path: "/skills/dataviz",
      enabled: true,
    } as Extract<ComposerCommandItem, { type: "skill" }>["skill"],
    label: "dataviz",
    description: "Charts",
  };

  it("names each section after where its commands come from", () => {
    expect(
      groupCommandItems([appCommand, claudeCommand, skill], "slash-command", true).map((group) => [
        group.label,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["Moss", ["slash:model"]],
      ["Claude", ["provider-command:claudeAgent:compact"]],
      ["Skills", ["skill:/skills/dataviz"]],
    ]);
  });

  it("puts a section where its best-ranked row is, keeping the ranking inside it", () => {
    const secondAppCommand: ComposerCommandItem = {
      ...appCommand,
      id: "slash:clear",
      command: "clear",
      label: "/clear",
    };
    const ranked = [claudeCommand, appCommand, skill, secondAppCommand];

    expect(groupCommandItems(ranked, "slash-command", true).map((group) => group.label)).toEqual([
      "Claude",
      "Moss",
      "Skills",
    ]);
    expect(orderSlashCommandItemsByGroup(ranked).map((item) => item.id)).toEqual([
      "provider-command:claudeAgent:compact",
      "slash:model",
      "slash:clear",
      "skill:/skills/dataviz",
    ]);
  });

  it("keeps one unlabelled list when sections are turned off", () => {
    expect(groupCommandItems([appCommand, claudeCommand], "slash-command", false)).toEqual([
      { id: "default", label: null, items: [appCommand, claudeCommand] },
    ]);
  });
});

describe("composerCommandMenuKeyHints", () => {
  it("names what Enter does for the open menu", () => {
    const enterLabel = (triggerKind: "slash-command" | "slash-model" | "mention" | "skill") =>
      composerCommandMenuKeyHints({ triggerKind, hasItems: true, escapeClosesMenu: true }).find(
        (hint) => hint.keys.includes("↵"),
      )?.label;

    expect(enterLabel("slash-command")).toBe("Run");
    expect(enterLabel("slash-model")).toBe("Select");
    expect(enterLabel("mention")).toBe("Insert");
    expect(enterLabel("skill")).toBe("Insert");
  });

  it("only offers keys that do something", () => {
    expect(
      composerCommandMenuKeyHints({
        triggerKind: "slash-command",
        hasItems: false,
        escapeClosesMenu: true,
      }).map((hint) => hint.label),
    ).toEqual(["Close"]);
    expect(
      composerCommandMenuKeyHints({
        triggerKind: "slash-command",
        hasItems: true,
        escapeClosesMenu: false,
      }).map((hint) => hint.label),
    ).toEqual(["Navigate", "Run"]);
  });
});

describe("groupCommandItems @devs", () => {
  it("keeps the @devs report above every other mention, whatever else matches", () => {
    const items: ComposerCommandItem[] = [
      {
        id: "thread:thread-devin",
        type: "thread",
        threadId: "thread-devin",
        provider: "devin",
        mention: { name: "Synthetic Devin session", path: "thread://thread-devin" },
        label: "Synthetic Devin session",
        description: "Moss",
      },
      {
        id: "devs-report",
        type: "devs-report",
        label: "@devs",
        description: "Report a problem to the Moss developers",
      },
    ];

    const groups = groupCommandItems(items, "mention", true);
    expect(groups[0]).toEqual({ id: "devs-report", label: null, items: [items[1]] });
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([
      "devs-report",
      "thread:thread-devin",
    ]);
  });
});
