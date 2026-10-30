// FILE: WorkflowRunCard.test.ts
// Purpose: Verifies narrow workflow effort localization without rewriting provider-defined values.
// Layer: Web chat component tests

import { describe, expect, it } from "vitest";

import { translateMoss, type TranslationKey } from "../../localization";
import { localizeKnownWorkflowEffortLabel } from "./WorkflowRunCard";

const translate =
  (locale: "en" | "zh-CN") =>
  (key: TranslationKey): string =>
    translateMoss(locale, key);

describe("localizeKnownWorkflowEffortLabel", () => {
  it.each([
    ["minimal", "Minimal", "最少"],
    ["low", "Low", "低"],
    ["medium", "Medium", "中等"],
    ["high", "High", "高"],
    ["xhigh", "Extra high", "极高"],
    ["max", "Max", "最大"],
  ] as const)("localizes the canonical %s effort", (effort, en, zhCN) => {
    expect(localizeKnownWorkflowEffortLabel(translate("en"), effort)).toBe(en);
    expect(localizeKnownWorkflowEffortLabel(translate("zh-CN"), effort)).toBe(zhCN);
  });

  it.each(["vendor-quantum", "High", " high ", "深度"])(
    "preserves the unknown effort %s byte-for-byte",
    (effort) => {
      expect(localizeKnownWorkflowEffortLabel(translate("zh-CN"), effort)).toBe(effort);
    },
  );
});
