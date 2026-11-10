import { describe, expect, it } from "vitest";

import {
  MOSS_BUILT_IN_APPS,
  isMossBuiltInAppId,
  mossBuiltInAppForTool,
  normalizeDisabledMossApps,
} from "./mossBuiltInApps";

describe("mossBuiltInAppForTool", () => {
  it.each([
    ["moss_pages_read", "moss.space"],
    ["moss_pages_mutate", "moss.space"],
    ["moss_space_create_item", "moss.space"],
    ["moss_sheet_write_range", "moss.space"],
    ["moss_slides_create", "moss.slides"],
    ["moss_app_publish", "moss.page-apps"],
    ["moss_app_db", "moss.page-apps"],
    ["moss_media_generate", "moss.media"],
    ["moss_canvas_open", "moss.media"],
    ["moss_create_automation", "moss.automations"],
    ["moss_list_automations", "moss.automations"],
    ["moss_view_automation", "moss.automations"],
    ["moss_create_kanban_task", "moss.tasks"],
    ["moss_read_kanban_board", "moss.tasks"],
    ["moss_set_kanban_goal", "moss.tasks"],
    ["moss_create_todo", "moss.todos"],
    ["moss_list_todos", "moss.todos"],
  ])("puts %s in %s", (tool, app) => {
    expect(mossBuiltInAppForTool(tool)).toBe(app);
  });

  it.each([
    // Moss's core: threads, projects, the browser, computer use, Moss Apps.
    "moss_list_threads",
    "moss_create_threads",
    "moss_project_list_tasks",
    "moss_project_library_add",
    "moss_capabilities",
    "moss_apps",
    "browser_run",
    "computer_click",
    "computer_spaces",
    "html_preview",
    // A running automation must still be able to report back.
    "moss_report_automation_result",
    "moss_update_automation_memory",
  ])("leaves %s with no app", (tool) => {
    expect(mossBuiltInAppForTool(tool)).toBeNull();
  });
});

describe("catalog", () => {
  it("has unique ids", () => {
    const ids = MOSS_BUILT_IN_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isMossBuiltInAppId)).toBe(true);
  });

  it("drops unknown ids from the saved list", () => {
    expect([...normalizeDisabledMossApps(["moss.media", "moss.retired", "moss.media"])]).toEqual([
      "moss.media",
    ]);
    expect(normalizeDisabledMossApps(undefined).size).toBe(0);
  });
});
