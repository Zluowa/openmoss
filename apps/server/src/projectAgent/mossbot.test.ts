import { describe, expect, it } from "vitest";
import { MOSSBOT_INSTRUCTIONS, MOSSBOT_PLAYBOOK, mossbotWelcome } from "./mossbot.ts";

describe("personal assistant context", () => {
  it("allows direct personal work and retains the existing durable task protocol", () => {
    expect(MOSSBOT_PLAYBOOK).toContain("research, writing, planning");
    expect(MOSSBOT_PLAYBOOK).not.toContain("You do not write application code yourself");
    expect(MOSSBOT_PLAYBOOK).toContain("moss_create_threads");
    expect(MOSSBOT_PLAYBOOK).toContain("same requestId");
    expect(MOSSBOT_INSTRUCTIONS).toContain("never save credentials");
  });

  it("welcomes the user in either supported app language", () => {
    expect(mossbotWelcome("Nova", "en")).toContain("Hi, I'm Nova");
    expect(mossbotWelcome("小莫", "zh-CN")).toContain("你好，我是 小莫");
  });
});
