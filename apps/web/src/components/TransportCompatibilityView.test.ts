import {
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsCompatibilityError,
  type WsCompatibilityAction,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME } from "../branding";
import { formatMossTranslation, translateMoss } from "../localization";
import { transportCompatibilityTranslationKeys } from "./TransportCompatibilityView";

function issue(
  action: WsCompatibilityAction,
  code: WsCompatibilityError["code"],
): WsCompatibilityError {
  return new WsCompatibilityError({
    message: "Raw server diagnostic that must not select UI copy.",
    code,
    retryable: false,
    action,
    serverBuild: "9.8.7-test",
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MIN_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
  });
}

describe("transport compatibility localization", () => {
  it.each([
    [
      "update-client",
      "This Moss client needs an update.",
      "此 Moss 客户端需要更新。",
      "Update or reload this client, then reconnect.",
      "请更新或重新加载此客户端，然后重新连接。",
    ],
    [
      "update-server",
      "The Moss server needs an update.",
      "Moss 服务器需要更新。",
      "Update or restart the server, then reload this client.",
      "请更新或重启服务器，然后重新加载此客户端。",
    ],
    [
      "reload",
      "Moss needs to reconnect with a matching build.",
      "Moss 需要使用匹配的版本重新连接。",
      "Reload the app. If this repeats, restart Moss so the client and server use matching builds.",
      "请重新加载应用。若问题再次出现，请重启 Moss，确保客户端与服务器使用匹配的版本。",
    ],
  ] as const)(
    "localizes the %s action in English and Chinese",
    (action, englishTitle, chineseTitle, englishGuidance, chineseGuidance) => {
      const keys = transportCompatibilityTranslationKeys(issue(action, "WS_PROTOCOL_INCOMPATIBLE"));
      const values = { appName: APP_DISPLAY_NAME };
      const expectedAppName = APP_DISPLAY_NAME;

      expect(formatMossTranslation("en", keys.title, values)).toBe(
        englishTitle.replaceAll("Moss", expectedAppName),
      );
      expect(formatMossTranslation("zh-CN", keys.title, values)).toBe(
        chineseTitle.replaceAll("Moss", expectedAppName),
      );
      expect(formatMossTranslation("en", keys.guidance, values)).toBe(
        englishGuidance.replaceAll("Moss", expectedAppName),
      );
      expect(formatMossTranslation("zh-CN", keys.guidance, values)).toBe(
        chineseGuidance.replaceAll("Moss", expectedAppName),
      );
    },
  );

  it.each([
    [
      "WS_PROTOCOL_INCOMPATIBLE",
      "The client and server use incompatible WebSocket protocols.",
      "客户端与服务器的 WebSocket 协议不兼容。",
    ],
    [
      "WS_CAPABILITIES_INCOMPATIBLE",
      "The server is missing WebSocket capabilities required by this client.",
      "服务器缺少客户端所需的 WebSocket 能力。",
    ],
    [
      "WS_NEGOTIATION_REQUIRED",
      "The connection has not completed WebSocket compatibility negotiation.",
      "连接尚未完成 WebSocket 兼容性协商。",
    ],
    [
      "WS_SERVER_GENERATION_CHANGED",
      "The server restarted during the connection. Reload the app to reconnect.",
      "服务器已在连接期间重启，请重新加载应用以建立新连接。",
    ],
  ] as const)("localizes the %s reason", (code, english, chinese) => {
    const { reason } = transportCompatibilityTranslationKeys(issue("reload", code));

    expect(translateMoss("en", reason)).toBe(english);
    expect(translateMoss("zh-CN", reason)).toBe(chinese);
  });
});
