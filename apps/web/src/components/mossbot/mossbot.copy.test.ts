import { describe, expect, it } from "vitest";

import { MOSSBOT_ROOM_ERROR_CODES } from "@moss/contracts";

import { mossbotErrorText } from "./mossbot.copy";

describe("mossbotErrorText", () => {
  it("localizes a known service failure even when the transport wraps it", () => {
    expect(
      mossbotErrorText(
        new Error(
          "Mossbot group operation failed: Stop the group before changing its members or responder.",
        ),
        "zh-CN",
      ),
    ).toBe("请先停止群聊，再修改成员或默认回复者。");
    expect(mossbotErrorText({ message: "Room not found." }, "en")).toBe("Room not found.");
  });

  it("never shows raw diagnostic text", () => {
    const raw = new Error("ECONNRESET at C:\\Users\\someone\\moss\\server.js:12");
    expect(mossbotErrorText(raw, "zh-CN")).toBe("操作没有完成，请重试。");
    expect(mossbotErrorText(raw, "en")).toBe("Something went wrong. Please retry.");
    expect(mossbotErrorText(raw, "zh-CN", "Could not create this assistant.")).toBe(
      "无法创建这个助手，请重试。",
    );
    expect(mossbotErrorText("provider exited with code 1", "zh-CN", "")).toBe("");
  });
});

describe("mossbotErrorText by code", () => {
  it("localizes the wire code of a room failure, whatever the message says", () => {
    expect(
      mossbotErrorText({ code: "mossbot.stop_first", message: "An error occurred" }, "zh-CN"),
    ).toBe("请先停止群聊，再修改成员或默认回复者。");
    expect(mossbotErrorText("member_turn_failed", "zh-CN", "")).toBe("这位助手没能回复，请重试。");
    expect(mossbotErrorText({ code: "mossbot.ambiguous_name" }, "en")).toBe(
      "Several assistants share this name. Choose one from the member list.",
    );
  });

  it("has a Chinese sentence for every room error code", () => {
    for (const code of MOSSBOT_ROOM_ERROR_CODES) {
      const text = mossbotErrorText({ code: `mossbot.${code}` }, "zh-CN");
      expect(text, code).toMatch(/[一-鿿]/u);
      expect(text, code).not.toBe("操作没有完成，请重试。");
    }
  });
});
