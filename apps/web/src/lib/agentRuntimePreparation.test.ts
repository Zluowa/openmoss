import type { DesktopAgentRuntimeState } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { formatMossTranslation } from "../localization";
import {
  agentRuntimeNameForProvider,
  describeAgentRuntimePreparation,
  pendingAgentRuntimeFor,
} from "./agentRuntimePreparation";

const codex = (patch: Partial<DesktopAgentRuntimeState>): DesktopAgentRuntimeState => ({
  name: "codex",
  version: "0.166.0",
  phase: "downloading",
  bytes: 72_400_000,
  total: 114_600_000,
  secondsLeft: 20,
  failure: null,
  retryInMs: null,
  ...patch,
});

const line = (state: DesktopAgentRuntimeState, locale: "zh-CN" | "en") => {
  const text = describeAgentRuntimePreparation(state, (key, values) =>
    formatMossTranslation(locale, key, values),
  );
  return formatMossTranslation(locale, text.key, text.values);
};

describe("agent runtime preparation", () => {
  it("needs Codex's runtime for Codex chats and Claude's for Claude chats, none for others", () => {
    expect(agentRuntimeNameForProvider("codex")).toBe("codex");
    expect(agentRuntimeNameForProvider("claudeAgent")).toBe("claude");
    expect(agentRuntimeNameForProvider("opencode")).toBeNull();
    const states = [codex({}), { ...codex({}), name: "claude", phase: "ready" as const }];
    expect(pendingAgentRuntimeFor("codex", states)?.name).toBe("codex");
    expect(pendingAgentRuntimeFor("claudeAgent", states)).toBeNull();
    expect(pendingAgentRuntimeFor("codex", [])).toBeNull();
  });

  it("says what is happening in plain words with progress and the time left", () => {
    expect(line(codex({}), "zh-CN")).toBe(
      "正在准备智能体，首次使用需要下载 · 63%（72 / 115 MB），约剩 20 秒",
    );
    expect(line(codex({ secondsLeft: 125 }), "zh-CN")).toBe(
      "正在准备智能体，首次使用需要下载 · 63%（72 / 115 MB），约剩 3 分钟",
    );
    expect(line(codex({}), "en")).toBe(
      "Getting the agent ready. The first time, Moss downloads it · 63% (72 / 115 MB), about 20 s left",
    );
    expect(line(codex({ bytes: 0, secondsLeft: null }), "zh-CN")).toBe(
      "正在准备智能体，首次使用需要下载…",
    );
    expect(line(codex({ phase: "installing" }), "zh-CN")).toBe("正在准备智能体：马上就好…");
  });

  it("gives every problem a next step, with 重试 where pressing it helps", () => {
    const offline = codex({ phase: "waiting", failure: "offline", retryInMs: 30_000 });
    expect(line(offline, "zh-CN")).toBe("没有网络连接。联网后会自动继续（已完成 63%）。");
    expect(
      describeAgentRuntimePreparation(offline, (key, values) =>
        formatMossTranslation("zh-CN", key, values),
      ).canRetry,
    ).toBe(true);
    expect(line(codex({ phase: "failed", failure: "proxy" }), "zh-CN")).toContain("代理");
    expect(line(codex({ phase: "failed", failure: "disk" }), "zh-CN")).toBe(
      "磁盘空间不足。清理一些空间后点重试。",
    );
    expect(line(codex({ phase: "failed", failure: "mismatch" }), "zh-CN")).toBe(
      "下载的文件不完整，已删除。请重试。",
    );
    expect(line(codex({ phase: "failed", failure: "stalled" }), "zh-CN")).toBe(
      "暂时无法下载智能体，Moss 会自动重试。",
    );
  });

  it("never names an engine or a runtime to the person", () => {
    for (const locale of ["zh-CN", "en"] as const)
      for (const state of [
        codex({}),
        codex({ phase: "failed", failure: "proxy" }),
        codex({ phase: "paused" }),
      ])
        expect(line(state, locale)).not.toMatch(/运行环境|runtime|codex|claude/iu);
  });
});
