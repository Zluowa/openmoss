import { describe, expect, it } from "vitest";

import {
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageTextStyle,
  userMessageBubbleBorderClassName,
} from "./chatTypography";

describe("userMessageBubbleBorderClassName", () => {
  it("keeps bubble geometry stable while distinguishing temporary Moss tasks", () => {
    const temporary = userMessageBubbleBorderClassName(true);
    const persistent = userMessageBubbleBorderClassName(false);

    expect(temporary).toContain("border-dashed");
    expect(temporary).toContain(
      "border-[color:color-mix(in_srgb,var(--color-primary)_60%,transparent)]",
    );
    expect(persistent).toContain("border-transparent");
  });
});

it("keeps default and customized message measurement in sync with rendered text", () => {
  expect(getChatTranscriptTextStyle()).toEqual({ fontSize: "16px", lineHeight: "24px" });
  expect(getChatTranscriptUserMessageTextStyle()).toEqual(getChatTranscriptTextStyle());
  expect(getChatTranscriptTextStyle(18)).toEqual({ fontSize: "21px", lineHeight: "32px" });
  expect(getChatTranscriptUserMessageTextStyle(18)).toEqual(getChatTranscriptTextStyle(18));
});
