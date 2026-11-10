import { describe, expect, it } from "vitest";

import { automationDisplayName } from "./automationDisplayName";

const eventSchedule = { type: "project-event", projectId: "project-1" } as never;
const cronSchedule = { type: "cron", expression: "0 9 * * *" } as never;

describe("automationDisplayName", () => {
  it("shows an assistant's English event automation in Chinese", () => {
    expect(automationDisplayName({ name: "Moss events", schedule: eventSchedule }, "zh-CN")).toBe(
      "Moss · 项目事件",
    );
  });

  it("keeps English, names people typed, and other schedules as they are", () => {
    expect(automationDisplayName({ name: "Moss events", schedule: eventSchedule }, "en")).toBe(
      "Moss events",
    );
    expect(automationDisplayName({ name: "每日早报", schedule: eventSchedule }, "zh-CN")).toBe(
      "每日早报",
    );
    expect(automationDisplayName({ name: "Deploy events", schedule: cronSchedule }, "zh-CN")).toBe(
      "Deploy events",
    );
  });
});
