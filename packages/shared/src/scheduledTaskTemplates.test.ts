// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  localizedTemplateText,
  SCHEDULED_PAGE_COPY,
  SCHEDULED_TASK_TEMPLATES,
} from "./scheduledTaskTemplates";

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe("scheduledTaskTemplates", () => {
  it("provides 8 curated work and life templates without emojis", () => {
    expect(SCHEDULED_TASK_TEMPLATES).toHaveLength(8);
    expect(SCHEDULED_TASK_TEMPLATES.some((t) => t.category === "work")).toBe(true);
    expect(SCHEDULED_TASK_TEMPLATES.some((t) => t.category === "life")).toBe(true);
    expect(SCHEDULED_TASK_TEMPLATES.filter((t) => t.featuredInEmpty).length).toBeGreaterThanOrEqual(
      5,
    );

    const ids = new Set<string>();
    for (const template of SCHEDULED_TASK_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      expect(template.title.zh.trim().length).toBeGreaterThan(0);
      expect(template.title.en.trim().length).toBeGreaterThan(0);
      expect(template.summary.zh.trim().length).toBeGreaterThan(0);
      expect(template.summary.en.trim().length).toBeGreaterThan(0);
      expect(template.scheduleMeta.zh.trim().length).toBeGreaterThan(0);
      expect(template.scheduleMeta.en.trim().length).toBeGreaterThan(0);
      expect(template.prompt.zh.trim().length).toBeGreaterThan(0);
      expect(template.prompt.en.trim().length).toBeGreaterThan(0);
      expect(EMOJI_PATTERN.test(template.title.zh + template.summary.zh)).toBe(false);
      expect(EMOJI_PATTERN.test(template.title.en + template.summary.en)).toBe(false);
    }
  });

  it("localizes shared page copy cleanly for zh and en", () => {
    expect(localizedTemplateText(SCHEDULED_PAGE_COPY.title, true)).toBe("定时任务");
    expect(localizedTemplateText(SCHEDULED_PAGE_COPY.tabYours, true)).toBe("我的任务");
    expect(localizedTemplateText(SCHEDULED_PAGE_COPY.tabTemplates, true)).toBe("模板");
    expect(localizedTemplateText(SCHEDULED_PAGE_COPY.localHint, true)).toBe(
      "本地定时任务仅在电脑开机并联网时运行。",
    );
  });
});
