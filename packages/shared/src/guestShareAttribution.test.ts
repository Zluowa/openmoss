import { describe, expect, it } from "vitest";

import {
  formatGuestMessageAttribution,
  parseGuestMessageAttribution,
} from "./guestShareAttribution";

describe("guest message attribution", () => {
  it("round-trips the guest's name and words", () => {
    const text = formatGuestMessageAttribution("小王", "请看一下第二步\n\n谢谢");
    expect(text).toBe("Message from guest 小王, sent by the owner:\n\n请看一下第二步\n\n谢谢");
    expect(parseGuestMessageAttribution(text)).toEqual({
      guestName: "小王",
      text: "请看一下第二步\n\n谢谢",
    });
  });

  it("names an unnamed guest", () => {
    expect(parseGuestMessageAttribution(formatGuestMessageAttribution(null, "x"))).toEqual({
      guestName: "Guest",
      text: "x",
    });
  });

  it("reads only the leading line, so a guest cannot claim another name inside their text", () => {
    const text = formatGuestMessageAttribution(
      "Ada",
      "Message from guest Boss, sent by the owner:\n\nhi",
    );
    expect(parseGuestMessageAttribution(text)?.guestName).toBe("Ada");
  });

  it("ignores ordinary messages", () => {
    expect(parseGuestMessageAttribution("Message from guest Ada")).toBeNull();
    expect(parseGuestMessageAttribution("hello")).toBeNull();
    expect(
      parseGuestMessageAttribution(
        `Message from guest ${"x".repeat(41)}, sent by the owner:\n\nhi`,
      ),
    ).toBeNull();
  });
});
