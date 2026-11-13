// FILE: mossBuiltInApps.ts
// Purpose: The catalog of Moss's own apps (资料空间, 幻灯片, 小应用, …): which
//          agent-gateway tool families each one hands to agents, and the one
//          rule that maps a tool name to its app. Settings › 插件 › 应用 lists
//          these; the gateway hides the tools of an app the person turned off.
// Layer: Shared runtime (server agent gateway + web settings)
// Exports: MOSS_BUILT_IN_APPS, MossBuiltInAppId, MossBuiltInAppPanel,
//          mossBuiltInAppForTool, isMossBuiltInAppId, normalizeDisabledMossApps

/** Where an app's own surface opens, when it has one. The web app maps each to a route. */
export type MossBuiltInAppPanel = "library" | "page-apps" | "images" | "automations" | "tasks";

export interface MossBuiltInApp {
  readonly id: string;
  /**
   * Tool names this app gives agents: a name belongs to the app when it starts
   * with one of `toolPrefixes` or matches one of `toolPatterns`. Families, not
   * lists, so a new tool in a family joins its app without touching this file.
   */
  readonly toolPrefixes: ReadonlyArray<string>;
  readonly toolPatterns: ReadonlyArray<RegExp>;
  readonly panel: MossBuiltInAppPanel | null;
}

export const MOSS_BUILT_IN_APPS = [
  {
    id: "moss.space",
    toolPrefixes: ["moss_pages_", "moss_space_", "moss_sheet_", "moss_design_"],
    toolPatterns: [],
    panel: "library",
  },
  {
    id: "moss.slides",
    toolPrefixes: ["moss_slides_"],
    toolPatterns: [],
    panel: "library",
  },
  {
    id: "moss.page-apps",
    toolPrefixes: ["moss_app_"],
    toolPatterns: [],
    panel: "page-apps",
  },
  {
    id: "moss.media",
    toolPrefixes: ["moss_media_", "moss_canvas_"],
    toolPatterns: [],
    panel: "images",
  },
  {
    id: "moss.automations",
    toolPrefixes: [],
    // Authoring only. A running automation reports back with
    // moss_report_automation_result / moss_update_automation_memory, which
    // stay on so automations made before the switch went off still finish.
    toolPatterns: [/^moss_(?:create|list|update|cancel|view)_automations?$/u],
    panel: "automations",
  },
  {
    id: "moss.tasks",
    toolPrefixes: [],
    // moss_create_kanban_task, moss_read_kanban_board, moss_set_kanban_goal, …
    toolPatterns: [/^moss_[a-z]+_kanban_[a-z_]+$/u],
    panel: "tasks",
  },
  {
    id: "moss.todos",
    toolPrefixes: [],
    // moss_create_todo, moss_list_todos, moss_update_todo
    toolPatterns: [/^moss_[a-z]+_todos?$/u],
    panel: null,
  },
] as const satisfies ReadonlyArray<MossBuiltInApp>;

export type MossBuiltInAppId = (typeof MOSS_BUILT_IN_APPS)[number]["id"];

const BUILT_IN_APP_IDS: ReadonlySet<string> = new Set(MOSS_BUILT_IN_APPS.map((app) => app.id));

export function isMossBuiltInAppId(value: string): value is MossBuiltInAppId {
  return BUILT_IN_APP_IDS.has(value);
}

/** The built-in app a gateway tool belongs to, or null for Moss's core tools. */
export function mossBuiltInAppForTool(toolName: string): MossBuiltInAppId | null {
  for (const app of MOSS_BUILT_IN_APPS) {
    const apps: MossBuiltInApp = app;
    if (apps.toolPrefixes.some((prefix) => toolName.startsWith(prefix))) return app.id;
    if (apps.toolPatterns.some((pattern) => pattern.test(toolName))) return app.id;
  }
  return null;
}

/**
 * The saved `apps.disabled` list as a set of known ids: unknown ids (an app a
 * later build retired) are dropped so they never hide anything.
 */
export function normalizeDisabledMossApps(
  disabled: ReadonlyArray<string> | undefined,
): ReadonlySet<MossBuiltInAppId> {
  const result = new Set<MossBuiltInAppId>();
  for (const id of disabled ?? []) {
    if (isMossBuiltInAppId(id)) result.add(id);
  }
  return result;
}
