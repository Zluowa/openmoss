import { describe, expect, it } from "vitest";

import { translateMoss } from "~/localization";
import { pageGuestCopy } from "./pageGuestCopy";

describe("guest lines a person relies on", () => {
  it("says a pending request opens by itself and the link still works later", () => {
    expect(pageGuestCopy("zh-CN").request.pendingDetail).toBe(
      "批准后页面会自动打开，也可以稍后用同一个链接回来。",
    );
  });

  it("says the owner sees each guest message first", () => {
    expect(translateMoss("zh-CN", "guest.composer.hint")).toBe("对方确认后，消息才会发给智能体。");
  });
});
