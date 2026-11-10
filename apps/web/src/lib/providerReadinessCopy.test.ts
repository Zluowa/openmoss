import { describe, expect, it } from "vitest";

import { formatMossTranslation } from "~/localization";
import { providerInstallStateKey, providerReadinessDescriptionKey } from "./providerReadinessCopy";

describe("provider readiness copy", () => {
  it("gives an explicit restart recovery step for an unproven install cleanup", () => {
    const key = providerInstallStateKey({
      status: "failed",
      phase: null,
      source: null,
      startedAt: null,
      finishedAt: null,
      version: null,
      reason: "cleanup-unproven",
    });
    expect(formatMossTranslation("zh-CN", key!, { provider: "Cursor" })).toBe(
      "Cursor 安装进程尚未确认关闭，请重启 Moss 后重试。",
    );
    expect(formatMossTranslation("en", key!, { provider: "Cursor" })).toContain("Restart Moss");
  });
  it("says what a signed-out new user can do with Moss's own agents", () => {
    const key = providerReadinessDescriptionKey({ state: "needsLogin", reason: "moss-sign-in" });
    expect(key).toBe("provider.readiness.reason.moss-sign-in");
    expect(formatMossTranslation("zh-CN", key!, {})).toBe(
      "登录 Moss 即可使用，新用户赠送 ¥5 额度。",
    );
  });

  it("never falls through to raw text for an unknown code", () => {
    expect(
      providerReadinessDescriptionKey({ state: "error", reason: "Codex marker at /tmp/x is bad" }),
    ).toBe("provider.readiness.reason.failed-to-run");
    expect(
      providerInstallStateKey({
        status: "failed",
        phase: null,
        source: null,
        startedAt: null,
        finishedAt: null,
        version: null,
        reason: "something new",
      }),
    ).toBe("provider.install.failed.download-failed");
  });

  it("formats the not-installed line and install progress in Chinese", () => {
    const key = providerReadinessDescriptionKey({ state: "notInstalled", install: "oneClick" });
    expect(formatMossTranslation("zh-CN", key!, { provider: "OpenCode" })).toBe(
      "这台电脑上还没有 OpenCode。",
    );
    const progress = providerInstallStateKey({
      status: "running",
      phase: "installing",
      source: "cn-mirror",
      startedAt: null,
      finishedAt: null,
      version: null,
      reason: null,
    });
    expect(formatMossTranslation("zh-CN", progress!, { provider: "OpenCode" })).toBe(
      "正在安装 OpenCode…",
    );
    expect(providerReadinessDescriptionKey({ state: "ready" })).toBeNull();
  });
});
