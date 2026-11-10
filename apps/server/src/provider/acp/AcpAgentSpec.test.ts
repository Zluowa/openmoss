import { describe, expect, it } from "vitest";

import { AcpRequestError, AcpTransportError } from "./AcpErrors.ts";
import {
  ACP_AGENT_SPECS,
  classifyKimiFailure,
  classifySignedOutFailure,
  classifyZcodeFailure,
  KIMI_ACP_AGENT_SPEC,
  kimiHostRequirement,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
  zcodeHostEnvironment,
  zcodeHostRequirement,
} from "./AcpAgentSpec.ts";

describe("zcodeHostEnvironment", () => {
  const nodeIn = (directory: string) => (candidate: string) =>
    candidate === `${directory}\\node.exe`;

  it("hands the bridge the PATH's Node on Windows", () => {
    expect(
      zcodeHostEnvironment(
        { PATH: "C:\\Windows;C:\\Program Files\\nodejs" },
        "win32",
        nodeIn("C:\\Program Files\\nodejs"),
      ),
    ).toEqual({ ZCODE_NODE: "C:\\Program Files\\nodejs\\node.exe" });
  });

  it("leaves an explicit Node, other platforms and a Node-less PATH alone", () => {
    const anywhere = () => true;
    expect(
      zcodeHostEnvironment({ ZCODE_NODE: "D:\\node.exe", PATH: "C:\\n" }, "win32", anywhere),
    ).toEqual({});
    expect(zcodeHostEnvironment({ PATH: "/usr/bin" }, "linux", anywhere)).toEqual({});
    expect(zcodeHostEnvironment({ PATH: "C:\\Windows" }, "win32", () => false)).toEqual({});
  });
});

describe("kimiHostRequirement", () => {
  const nothing = () => false;

  it("says what to do on Windows with no Git Bash", () => {
    const message = kimiHostRequirement({ PATH: "C:\\Windows" }, "win32", nothing);
    expect(message).toContain("Git Bash");
    expect(message).toContain("KIMI_SHELL_PATH");
  });

  it("accepts each place Kimi Code itself looks", () => {
    const only = (path: string) => (candidate: string) => candidate === path;
    expect(
      kimiHostRequirement(
        { KIMI_SHELL_PATH: "D:\\tools\\bash.exe", PATH: "" },
        "win32",
        only("D:\\tools\\bash.exe"),
      ),
    ).toBeUndefined();
    expect(
      kimiHostRequirement({ PATH: "" }, "win32", only("C:\\Program Files\\Git\\bin\\bash.exe")),
    ).toBeUndefined();
    expect(
      kimiHostRequirement(
        { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PATH: "" },
        "win32",
        only("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"),
      ),
    ).toBeUndefined();
    expect(
      kimiHostRequirement({ PATH: "D:\\git\\cmd" }, "win32", (candidate) =>
        candidate.replaceAll("/", "\\").toLowerCase().endsWith("\\git\\cmd\\git.exe"),
      ),
    ).toBeUndefined();
  });

  it("asks nothing of other platforms", () => {
    expect(kimiHostRequirement({ PATH: "" }, "darwin", nothing)).toBeUndefined();
    expect(kimiHostRequirement({ PATH: "" }, "linux", nothing)).toBeUndefined();
  });

  it("turns Kimi Code's startup error into the same instruction", () => {
    const failure = classifyKimiFailure(
      new AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "Git Bash was not found on this Windows host. Install Git for Windows." },
      }),
      KIMI_ACP_AGENT_SPEC,
    );
    expect(failure?.reason).toBe("backend_unavailable");
    expect(failure?.message).toContain("KIMI_SHELL_PATH");
  });

  it("still reports a signed-out Kimi Code as signed out", () => {
    expect(
      classifyKimiFailure(
        new AcpRequestError({ code: -32000, errorMessage: "Authentication required" }),
        KIMI_ACP_AGENT_SPEC,
      )?.reason,
    ).toBe("credentials_missing");
  });
});

describe("zcodeHostRequirement", () => {
  const onlyThese =
    (...paths: ReadonlyArray<string>) =>
    (candidate: string) =>
      paths.includes(candidate);

  it("says what to do when neither the desktop app nor a configured CLI exists", () => {
    const message = zcodeHostRequirement(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PATH: "C:\\Windows" },
      "win32",
      onlyThese(),
    );
    expect(message).toContain("Install the ZCode desktop app");
    expect(message).toContain("ZCODE_BIN");
  });

  it("accepts each place the bridge itself looks", () => {
    const desktop = "C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs";
    expect(
      zcodeHostRequirement(
        { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PATH: "C:\\Windows" },
        "win32",
        onlyThese(desktop),
      ),
    ).toBeUndefined();
    expect(
      zcodeHostRequirement(
        { HOME: "/Users/u", PATH: "/usr/bin" },
        "darwin",
        onlyThese("/Users/u/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
      ),
    ).toBeUndefined();
    expect(
      zcodeHostRequirement({ PATH: "/opt/bin" }, "linux", (candidate) =>
        candidate.replaceAll("\\", "/").endsWith("/opt/bin/zcode"),
      ),
    ).toBeUndefined();
  });

  it("trusts ZCODE_BIN alone when it is set, as the bridge does", () => {
    const desktop = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
    expect(
      zcodeHostRequirement(
        { ZCODE_BIN: "/opt/z/zcode.cjs", PATH: "" },
        "linux",
        onlyThese("/opt/z/zcode.cjs"),
      ),
    ).toBeUndefined();
    expect(
      zcodeHostRequirement({ ZCODE_BIN: "/gone/zcode.cjs", PATH: "" }, "linux", onlyThese(desktop)),
    ).toContain("could not be started");
  });
});

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
