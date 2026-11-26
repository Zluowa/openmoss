import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SERVER_SETTINGS,
  PLUGIN_SUGGESTION_ACTIVITY_KIND,
  type McpConnector,
  type MossAppConnection,
  type MossAppToolkit,
  type OrchestrationCommand,
} from "@moss/contracts";
import { MOSS_DEVELOPER_PLUGIN_ID } from "@moss/shared/mossDeveloperPlugin";
import { MOSS_GUIDE_PLUGIN_ID } from "@moss/shared/mossGuidePlugin";

import {
  PLUGIN_SUGGESTION_MAX_CARDS_PER_THREAD,
  PLUGIN_SUGGESTION_MAX_CARDS_PER_TURN,
  makeAgentGatewayPluginSuggestionTools,
  type PluginSuggestionToolsDeps,
} from "./pluginSuggestionTools.ts";

function makeToolkit(overrides: Partial<MossAppToolkit> = {}): MossAppToolkit {
  return {
    slug: "outlook",
    name: "Outlook",
    description: "Triage Outlook inboxes and calendar events",
    logoUrl: "https://example.com/outlook.png",
    categories: ["communication", "email"],
    toolsCount: 12,
    signIn: "managed",
    ...overrides,
  };
}

function setup(
  options: {
    toolkits?: MossAppToolkit[];
    connections?: MossAppConnection[];
    connectors?: McpConnector[];
    servicePluginsInstalled?: string[];
    installedNativeIds?: string[];
    region?: "cn" | "global";
    uninstalledOfficial?: string[];
    dismissedSuggestions?: ReadonlyArray<{ pluginId: string; dismissedAt: string }>;
    failMossApps?: boolean;
  } = {},
) {
  const dispatched: OrchestrationCommand[] = [];
  let seq = 0;

  const deps: PluginSuggestionToolsDeps = {
    orchestrationEngine: {
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: dispatched.length });
      },
    },
    serverSettings: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        officialPlugins: {
          uninstalled: options.uninstalledOfficial ?? [],
          dismissedSuggestions: [...(options.dismissedSuggestions ?? [])],
        },
      }),
    },
    readAccountRegion: () => Effect.succeed(options.region ?? "cn"),
    readInstalledNativePluginIds: () => Effect.succeed(new Set(options.installedNativeIds ?? [])),
    newSuggestionId: () => `sugg-${++seq}`,
    mcpConnectors: {
      list: () => Effect.succeed(options.connectors ?? []),
      servicePlugins: {
        list: () =>
          Effect.succeed({
            installed: options.servicePluginsInstalled ?? [],
            skills: [],
          }),
      },
      mossApps: {
        listToolkits: () =>
          options.failMossApps
            ? Effect.fail(new Error("authentication-required"))
            : Effect.succeed({ toolkits: options.toolkits ?? [makeToolkit()] }),
        listConnections: () =>
          options.failMossApps
            ? Effect.fail(new Error("authentication-required"))
            : Effect.succeed(options.connections ?? []),
      },
    } as unknown as NonNullable<PluginSuggestionToolsDeps["mcpConnectors"]>,
  };

  const [searchTool, suggestTool] = makeAgentGatewayPluginSuggestionTools(deps);
  if (!searchTool || !suggestTool) {
    throw new Error("Expected both search and suggest tools");
  }
  const callSearch = (input: Record<string, unknown>, threadId = "thread-1", turnId = "turn-1") =>
    Effect.runPromise(
      searchTool.handler(input, {
        callerThreadId: threadId,
        callerProvider: "codex",
        callerTurnId: turnId,
      } as Parameters<typeof searchTool.handler>[1]),
    );
  const callSuggest = (input: Record<string, unknown>, threadId = "thread-1", turnId = "turn-1") =>
    Effect.runPromise(
      suggestTool.handler(input, {
        callerThreadId: threadId,
        callerProvider: "codex",
        callerTurnId: turnId,
      } as Parameters<typeof suggestTool.handler>[1]),
    );
  return { searchTool, suggestTool, callSearch, callSuggest, dispatched };
}

function parseResult(result: { content: ReadonlyArray<{ type: string; text?: string }> }) {
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? (first.text ?? "{}") : "{}");
}

describe("moss_search_plugins & moss_suggest_plugins", () => {
  it("searches across all 5 sources with bilingual Chinese aliases and separates alreadyInstalled", async () => {
    const { callSearch } = setup({
      region: "cn",
      toolkits: [
        makeToolkit({ slug: "outlook", name: "Outlook Email" }),
        makeToolkit({
          slug: "gmail",
          name: "Gmail",
          description: "Read and send Gmail messages",
          categories: ["email"],
        }),
      ],
      connections: [
        {
          connectionId: "conn-1",
          toolkitSlug: "gmail",
          status: "active",
          createdAt: "2026-11-26T00:00:00.000Z",
        },
      ],
    });

    const mailResult = await callSearch({ query: "发送邮件" });
    expect(mailResult.isError).not.toBe(true);
    const mailJson = parseResult(mailResult);
    expect(
      mailJson.results.some(
        (r: { pluginId: string; installed: boolean }) =>
          r.pluginId === "outlook@moss-apps" && r.installed === false,
      ),
    ).toBe(true);
    expect(
      mailJson.results.some(
        (r: { pluginId: string; installed: boolean }) =>
          r.pluginId === "gmail@moss-apps" && r.installed === true,
      ),
    ).toBe(true);

    const mapResult = await callSearch({ query: "帮我查路线导航地图" });
    const mapJson = parseResult(mapResult);
    expect(
      mapJson.results.some((r: { sourceKind: string }) => r.sourceKind === "moss-service-plugin"),
    ).toBe(true);
  });

  it("gates CN-only service plugins when account region is global and fails soft when mossApps is unavailable", async () => {
    const { callSearch } = setup({
      region: "global",
      failMossApps: true,
    });
    const cnOnly = parseResult(await callSearch({ query: "打车 滴滴 高德" }));
    expect(
      cnOnly.results.some((r: { servicePluginId?: string }) => r.servicePluginId === "didi"),
    ).toBe(false);

    const catalogMatch = parseResult(await callSearch({ query: "github" }));
    expect(catalogMatch.results.length).toBeGreaterThan(0);
  });

  it("dispatches a plugin.suggested activity for valid non-installed IDs and rejects hallucinated/installed ones", async () => {
    const { callSuggest, dispatched } = setup({
      toolkits: [makeToolkit({ slug: "outlook", name: "Outlook Email" })],
      servicePluginsInstalled: ["taobao"],
    });

    const bad = await callSuggest({ pluginIds: ["does-not-exist@fake"] });
    expect(bad.isError).toBe(true);
    expect(dispatched).toHaveLength(0);

    const already = await callSuggest({ pluginIds: ["taobao@moss-service-plugins"] });
    expect(already.isError).not.toBe(true);
    expect(parseResult(already).alreadyInstalled).toEqual(["taobao@moss-service-plugins"]);
    expect(dispatched).toHaveLength(0);

    const ok = await callSuggest({
      pluginIds: ["outlook@moss-apps", "taobao@moss-service-plugins"],
    });
    expect(ok.isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: "thread-1",
      activity: {
        kind: PLUGIN_SUGGESTION_ACTIVITY_KIND,
        tone: "info",
        turnId: "turn-1",
        payload: {
          suggestionId: "sugg-1",
          suggestions: [
            {
              pluginId: "outlook@moss-apps",
              sourceKind: "moss-app",
              displayName: "Outlook Email",
            },
          ],
        },
      },
    });
  });

  it("enforces per-turn and per-thread rate caps and removes both tools when moss-guide is uninstalled", async () => {
    const { callSuggest } = setup({
      toolkits: [
        makeToolkit({ slug: "app1", name: "App 1" }),
        makeToolkit({ slug: "app2", name: "App 2" }),
        makeToolkit({ slug: "app3", name: "App 3" }),
        makeToolkit({ slug: "app4", name: "App 4" }),
        makeToolkit({ slug: "app5", name: "App 5" }),
        makeToolkit({ slug: "app6", name: "App 6" }),
        makeToolkit({ slug: "app7", name: "App 7" }),
      ],
    });

    for (let i = 1; i <= PLUGIN_SUGGESTION_MAX_CARDS_PER_TURN; i += 1) {
      expect(
        (await callSuggest({ pluginIds: [`app${i}@moss-apps`] }, "thread-cap", "turn-1")).isError,
      ).not.toBe(true);
    }
    const overTurn = await callSuggest({ pluginIds: ["app3@moss-apps"] }, "thread-cap", "turn-1");
    expect(overTurn.isError).toBe(true);

    for (let i = 3; i <= PLUGIN_SUGGESTION_MAX_CARDS_PER_THREAD; i += 1) {
      expect(
        (await callSuggest({ pluginIds: [`app${i}@moss-apps`] }, "thread-cap", `turn-${i}`))
          .isError,
      ).not.toBe(true);
    }
    const overThread = await callSuggest(
      { pluginIds: ["app7@moss-apps"] },
      "thread-cap",
      "turn-99",
    );
    expect(overThread.isError).toBe(true);

    const uninstalled = setup({ uninstalledOfficial: [MOSS_GUIDE_PLUGIN_ID] });
    expect((await uninstalled.callSearch({ query: "outlook" })).isError).toBe(true);
    expect((await uninstalled.callSuggest({ pluginIds: ["outlook@moss-apps"] })).isError).toBe(
      true,
    );
    expect(uninstalled.dispatched).toHaveLength(0);
  });

  it("never suggests Moss built-in image/video/canvas/web-builder capabilities", async () => {
    const { callSearch, callSuggest, dispatched } = setup();

    for (const query of ["生图", "视频", "画布"]) {
      const json = parseResult(await callSearch({ query }));
      expect(
        json.results.some((r: { pluginId: string }) => r.pluginId.endsWith("@moss-bundled")),
      ).toBe(false);
    }

    for (const builtinId of [
      "moss-imagegen@moss-bundled",
      "moss-videogen@moss-bundled",
      "moss-canvas@moss-bundled",
      "moss-web-builder@moss-bundled",
    ]) {
      const res = await callSuggest({ pluginIds: [builtinId] });
      expect(res.isError).toBe(true);
    }
    expect(dispatched).toHaveLength(0);
  });

  it("recommends explicit Google Mail / arbitrary Composio toolkits only when unconnected and supports fallback search", async () => {
    const customHubspot = makeToolkit({
      slug: "hubspot",
      name: "HubSpot",
      description: "Manage CRM contacts and deals",
      categories: ["crm"],
    });
    const customAirtable = makeToolkit({
      slug: "airtable",
      name: "Airtable",
      description: "Read and update Airtable bases",
      categories: ["productivity"],
    });

    const listToolkitsMock = (input: { all?: boolean; search?: string }) => {
      if (input.search) {
        return Effect.succeed({
          toolkits: [customAirtable].filter((t) => t.slug.includes(input.search!.toLowerCase())),
        });
      }
      return Effect.succeed({
        toolkits: [
          makeToolkit({
            slug: "gmail",
            name: "Gmail",
            description: "Send and read Google Mail messages",
            categories: ["email"],
          }),
          customHubspot,
        ],
      });
    };

    const { callSearch, callSuggest, dispatched } = (() => {
      const base = setup({
        toolkits: [
          makeToolkit({
            slug: "gmail",
            name: "Gmail",
            description: "Send and read Google Mail messages",
            categories: ["email"],
          }),
          customHubspot,
        ],
      });
      return base;
    })();

    const gmailSearch = parseResult(await callSearch({ query: "谷歌邮件" }));
    expect(gmailSearch.results[0]?.pluginId).toBe("gmail@moss-apps");
    expect(gmailSearch.results[0]?.installed).toBe(false);

    const suggestGmail = await callSuggest({ pluginIds: ["gmail@moss-apps"] });
    expect(suggestGmail.isError).not.toBe(true);
    expect(dispatched).toHaveLength(1);

    const hubspotSearch = parseResult(await callSearch({ query: "hubspot" }));
    expect(
      hubspotSearch.results.some((r: { pluginId: string }) => r.pluginId === "hubspot@moss-apps"),
    ).toBe(true);

    // Connected Gmail is never suggested again; only reported as alreadyInstalled.
    const alreadyConnected = setup({
      toolkits: [makeToolkit({ slug: "gmail", name: "Gmail" })],
      connections: [
        {
          connectionId: "conn-gmail",
          toolkitSlug: "gmail",
          status: "active",
          createdAt: "2026-11-26T00:00:00.000Z",
        },
      ],
    });
    const dupSuggest = await alreadyConnected.callSuggest({ pluginIds: ["gmail@moss-apps"] });
    expect(dupSuggest.isError).not.toBe(true);
    expect(parseResult(dupSuggest).alreadyInstalled).toEqual(["gmail@moss-apps"]);
    expect(alreadyConnected.dispatched).toHaveLength(0);

    // Targeted search fallback discovers toolkits omitted from the bulk list.
    const fallbackDispatched: OrchestrationCommand[] = [];
    const [fallbackSearch, fallbackSuggest] = makeAgentGatewayPluginSuggestionTools({
      orchestrationEngine: {
        dispatch: (command) => {
          fallbackDispatched.push(command);
          return Effect.succeed({ sequence: fallbackDispatched.length });
        },
      },
      serverSettings: {
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS }),
      },
      mcpConnectors: {
        list: () => Effect.succeed([]),
        servicePlugins: { list: () => Effect.succeed({ installed: [], skills: [] }) },
        mossApps: {
          listToolkits: listToolkitsMock as unknown as NonNullable<
            PluginSuggestionToolsDeps["mcpConnectors"]
          >["mossApps"]["listToolkits"],
          listConnections: () => Effect.succeed([]),
        },
      } as unknown as NonNullable<PluginSuggestionToolsDeps["mcpConnectors"]>,
    });

    const airtableRes = parseResult(
      await Effect.runPromise(
        fallbackSearch!.handler({ query: "airtable" }, {
          callerThreadId: "thread-fb",
          callerProvider: "codex",
          callerTurnId: "turn-fb",
        } as Parameters<NonNullable<typeof fallbackSearch>["handler"]>[1]),
      ),
    );
    expect(
      airtableRes.results.some((r: { pluginId: string }) => r.pluginId === "airtable@moss-apps"),
    ).toBe(true);

    const airtableSuggestRes = await Effect.runPromise(
      fallbackSuggest!.handler({ pluginIds: ["airtable@moss-apps"] }, {
        callerThreadId: "thread-fb",
        callerProvider: "codex",
        callerTurnId: "turn-fb",
      } as Parameters<NonNullable<typeof fallbackSuggest>["handler"]>[1]),
    );
    expect(airtableSuggestRes.isError).not.toBe(true);
    expect(fallbackDispatched).toHaveLength(1);
  });

  it("boosts core personal/office apps over niche mail tools, resolves 飞书 aliases, and blocks recently dismissed suggestions", async () => {
    const recentIso = new Date().toISOString();
    const expiredIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { callSearch, callSuggest, dispatched } = setup({
      toolkits: [
        makeToolkit({
          slug: "mailgun",
          name: "Mailgun",
          description: "Transactional email API for developers",
          categories: ["email"],
        }),
        makeToolkit({
          slug: "gmail",
          name: "Gmail",
          description: "Read and send Gmail messages",
          categories: ["email"],
        }),
        makeToolkit({
          slug: "lark",
          name: "Lark",
          description: "Team chat, docs, and approvals",
          categories: ["messaging"],
        }),
      ],
      dismissedSuggestions: [
        { pluginId: "gmail@moss-apps", dismissedAt: recentIso },
        { pluginId: "lark@moss-apps", dismissedAt: expiredIso },
      ],
    });

    const mailSearch = parseResult(await callSearch({ query: "邮件" }));
    expect(mailSearch.results[0]?.pluginId).toBe("gmail@moss-apps");
    expect(mailSearch.results[0]?.dismissed).toBe(true);

    const feishuSearch = parseResult(await callSearch({ query: "飞书" }));
    expect(feishuSearch.results[0]?.pluginId).toBe("lark@moss-apps");
    expect(feishuSearch.results[0]?.dismissed).toBe(false);

    // Server refuses to emit a card for an actively dismissed plugin.
    const blocked = parseResult(await callSuggest({ pluginIds: ["gmail@moss-apps"] }));
    expect(blocked.suggested).toEqual([]);
    expect(blocked.dismissed).toEqual(["gmail@moss-apps"]);
    expect(dispatched).toHaveLength(0);

    // Expired dismissal (>7d) is allowed again.
    const allowed = parseResult(await callSuggest({ pluginIds: ["lark@moss-apps"] }));
    expect(allowed.suggested).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it("discovers Moss Developer for app/reader/meeting prompts and suggests it only when uninstalled", async () => {
    const defaultSetup = setup();
    for (const query of ["做个阅读器", "会议工具", "智能会议工具", "moss-developer"]) {
      const search = parseResult(await defaultSetup.callSearch({ query }));
      expect(search.results[0]).toMatchObject({
        pluginId: MOSS_DEVELOPER_PLUGIN_ID,
        sourceKind: "moss-bundled",
        installed: true,
      });
    }
    const already = parseResult(
      await defaultSetup.callSuggest({ pluginIds: [MOSS_DEVELOPER_PLUGIN_ID] }),
    );
    expect(already.alreadyInstalled).toEqual([MOSS_DEVELOPER_PLUGIN_ID]);
    expect(defaultSetup.dispatched).toHaveLength(0);

    const uninstalledSetup = setup({
      uninstalledOfficial: [MOSS_DEVELOPER_PLUGIN_ID],
    });
    const searchWhenUninstalled = parseResult(
      await uninstalledSetup.callSearch({ query: "做一个AI阅读器应用" }),
    );
    expect(searchWhenUninstalled.results[0]).toMatchObject({
      pluginId: MOSS_DEVELOPER_PLUGIN_ID,
      sourceKind: "moss-bundled",
      installed: false,
    });
    const suggest = await uninstalledSetup.callSuggest({ pluginIds: [MOSS_DEVELOPER_PLUGIN_ID] });
    expect(suggest.isError).not.toBe(true);
    expect(uninstalledSetup.dispatched).toHaveLength(1);
    expect(uninstalledSetup.dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      activity: {
        kind: PLUGIN_SUGGESTION_ACTIVITY_KIND,
        payload: {
          suggestions: [
            {
              pluginId: MOSS_DEVELOPER_PLUGIN_ID,
              sourceKind: "moss-bundled",
              displayName: "Moss 开发者",
              requiresAuth: false,
            },
          ],
        },
      },
    });
  });
});
