import { describe, expect, it } from "vitest";

import { AcpRequestError, AcpTransportError } from "./AcpErrors.ts";
import {
  ACP_AGENT_SPECS,
  classifySignedOutFailure,
  classifyZcodeFailure,
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "./AcpAgentSpec.ts";

describe("ACP agent specs", () => {
  it("never map Moss modes onto a CLI mode that bypasses approvals", () => {
    for (const spec of Object.values(ACP_AGENT_SPECS)) {
      const alias = [...spec.modes.plan, ...spec.modes.implement, ...spec.modes.approval];
      for (const mode of alias) expect(spec.modes.never).not.toContain(mode);
    }
    expect(KIMI_ACP_AGENT_SPEC.modes.never).toEqual(["auto", "yolo"]);
    expect(ZCODE_ACP_AGENT_SPEC.modes.never).toContain("yolo");
    expect(ZCODE_ACP_AGENT_SPEC.modes.implement).toEqual(["build"]);
  });

  it("pins the ZCode bridge out of its yolo default and silences its status line", () => {
    expect(ZCODE_ACP_AGENT_SPEC.environmentDefaults).toEqual({
      ZCODE_ACP_MODE: "build",
      ZCODE_ACP_SHOW_COMPLETION_STATUS: "0",
    });
    expect(ZCODE_ACP_AGENT_SPEC.args).toEqual([]);
    expect(ZCODE_ACP_AGENT_SPEC.auth).toEqual({ policy: "upfront", methodId: "zcode-credentials" });
    expect(KIMI_ACP_AGENT_SPEC.auth.policy).toBe("on-demand");
    expect(MINIMAX_ACP_AGENT_SPEC.auth.policy).toBe("on-demand");
    expect(MINIMAX_ACP_AGENT_SPEC.permissionConfig).toEqual({
      id: "permissionMode",
      value: "default",
    });
  });

  it("relocates each CLI's data root through its own variable", () => {
    expect(KIMI_ACP_AGENT_SPEC.homeEnvironment("/private/kimi")).toEqual({
      KIMI_CODE_HOME: "/private/kimi",
    });
    expect(MINIMAX_ACP_AGENT_SPEC.homeEnvironment("/private/mcode")).toEqual({
      MINIMAX_DATA_DIR: "/private/mcode",
    });
    // The backend ignores a ZCODE_HOME whose basename is not `.zcode`.
    expect(ZCODE_ACP_AGENT_SPEC.homeEnvironment("/private/zcode").ZCODE_HOME).toMatch(
      /[\\/]\.zcode$/u,
    );
    expect(ZCODE_ACP_AGENT_SPEC.homeEnvironment("/private/.zcode")).toEqual({
      ZCODE_HOME: "/private/.zcode",
    });
  });
});

describe("classifySignedOutFailure", () => {
  it.each([
    [KIMI_ACP_AGENT_SPEC, "Authentication required", "kimi login"],
    [
      MINIMAX_ACP_AGENT_SPEC,
      "Authentication required: Run `mcode login` and try again.",
      "mcode login",
    ],
  ])("names the sign-in command for a signed-out %s", (spec, errorMessage, command) => {
    const failure = classifySignedOutFailure(
      new AcpRequestError({ code: -32000, errorMessage }),
      spec,
    );
    expect(failure?.reason).toBe("credentials_missing");
    expect(failure?.message).toContain(command);
    expect(failure?.message).toContain(spec.displayName);
  });

  it("ignores unrelated request and transport failures", () => {
    expect(
      classifySignedOutFailure(
        new AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
        KIMI_ACP_AGENT_SPEC,
      ),
    ).toBeUndefined();
    expect(
      classifySignedOutFailure(
        new AcpTransportError({ detail: "process exited", cause: new Error("exit 1") }),
        KIMI_ACP_AGENT_SPEC,
      ),
    ).toBeUndefined();
  });
});

describe("classifyZcodeFailure", () => {
  it("treats the upfront authenticate rejection as missing credentials", () => {
    const failure = classifyZcodeFailure(
      new AcpRequestError({
        code: -32000,
        errorMessage:
          "未找到 ZCode 凭据：请先登录 ZCode 桌面端，或运行 zcode-acp setup 保存账号，然后重试登录。",
      }),
      ZCODE_ACP_AGENT_SPEC,
    );
    expect(failure?.reason).toBe("credentials_missing");
    expect(failure?.message).toContain("ZCode desktop app");
    expect(failure?.message).toContain("zcode-acp setup");
  });

  it.each([
    "ZCode turn failed: session/create failed: ZCode backend reader exited (backend dead)",
    "spawn failed: zcode not found — install the ZCode CLI, put it on PATH, or set ZCODE_BIN",
  ])("points a missing or dead backend at the desktop app or ZCODE_BIN: %s", (errorMessage) => {
    const failure = classifyZcodeFailure(
      new AcpRequestError({ code: -32603, errorMessage }),
      ZCODE_ACP_AGENT_SPEC,
    );
    expect(failure?.reason).toBe("backend_unavailable");
    expect(failure?.message).toContain("ZCode desktop app");
    expect(failure?.message).toContain("ZCODE_BIN");
  });

  it("classifies first-prompt provider rejections by status code or wording", () => {
    const byStatus = classifyZcodeFailure(
      new AcpRequestError({
        code: -32603,
        errorMessage: "ZCode turn failed: request rejected",
        data: { type: "zcode_turn_failed", statusCode: 401, providerCode: "1000" },
      }),
      ZCODE_ACP_AGENT_SPEC,
    );
    expect(byStatus?.reason).toBe("credentials_missing");
    const byWording = classifyZcodeFailure(
      new AcpRequestError({
        code: -32603,
        errorMessage: "ZCode turn failed: invalid api key",
        data: { type: "zcode_turn_failed" },
      }),
      ZCODE_ACP_AGENT_SPEC,
    );
    expect(byWording?.message).toContain("unauthenticated");
    expect(
      classifyZcodeFailure(
        new AcpRequestError({
          code: -32603,
          errorMessage: "ZCode turn failed: rate limited",
          data: { type: "zcode_turn_failed", statusCode: 429, retryable: true },
        }),
        ZCODE_ACP_AGENT_SPEC,
      ),
    ).toBeUndefined();
  });
});
