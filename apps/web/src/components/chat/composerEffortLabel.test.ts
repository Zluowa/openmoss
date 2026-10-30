import { describe, expect, it } from "vitest";

import {
  resolveComposerEffortLabel,
  resolveSpecialComposerEffortLabel,
} from "./composerEffortLabel";

const localized = {
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中等",
  high: "高",
  extraHigh: "极高",
  thinking: "思考",
  ultra: "超高",
} as const;

describe("resolveComposerEffortLabel", () => {
  it("localizes the runtime none effort instead of leaking its English fallback", () => {
    expect(
      resolveComposerEffortLabel({
        provider: "grok",
        effort: "none",
        effortLevels: [{ value: "none", label: "None" }],
        localized,
      }),
    ).toBe("无");
  });

  it("keeps xhigh localized without collapsing max into the same label", () => {
    const effortLevels = [
      { value: "xhigh", label: "Extra High" },
      { value: "max", label: "Maximum" },
    ];

    expect(
      resolveComposerEffortLabel({ provider: "codex", effort: "xhigh", effortLevels, localized }),
    ).toBe("极高");
    expect(
      resolveComposerEffortLabel({ provider: "codex", effort: "max", effortLevels, localized }),
    ).toBe("Maximum");
  });

  it("localizes Antigravity's known runtime efforts", () => {
    expect(
      resolveComposerEffortLabel({
        provider: "antigravity",
        effort: "ultra",
        effortLevels: [{ value: "ultra", label: "Ultra reasoning" }],
        localized,
      }),
    ).toBe("超高");
    expect(
      resolveComposerEffortLabel({
        provider: "antigravity",
        effort: "thinking",
        effortLevels: [],
        localized,
      }),
    ).toBe("思考");
  });

  it("keeps English known labels and unknown runtime labels unchanged", () => {
    expect(
      resolveSpecialComposerEffortLabel({
        provider: "antigravity",
        effort: "thinking",
        fallbackLabel: "Thinking deeply",
        localized: { thinking: "Thinking", ultra: "Ultra" },
      }),
    ).toBe("Thinking");
    expect(
      resolveSpecialComposerEffortLabel({
        provider: "antigravity",
        effort: "ultra",
        fallbackLabel: "Ultra reasoning",
        localized: { thinking: "Thinking", ultra: "Ultra" },
      }),
    ).toBe("Ultra");
    expect(
      resolveSpecialComposerEffortLabel({
        provider: "antigravity",
        effort: "vendor-quantum",
        fallbackLabel: "Vendor Quantum Max",
        localized,
      }),
    ).toBe("Vendor Quantum Max");
    expect(
      resolveComposerEffortLabel({
        provider: "antigravity",
        effort: "vendor-quantum",
        effortLevels: [{ value: "vendor-quantum", label: "Vendor Quantum Max" }],
        localized,
      }),
    ).toBe("Vendor Quantum Max");
  });

  it("keeps non-Antigravity runtime thinking and ultra labels unchanged", () => {
    expect(
      resolveComposerEffortLabel({
        provider: "codex",
        effort: "thinking",
        effortLevels: [{ value: "thinking", label: "Thinking deeply" }],
        localized,
      }),
    ).toBe("Thinking deeply");
    expect(
      resolveComposerEffortLabel({
        provider: "codex",
        effort: "ultra",
        effortLevels: [{ value: "ultra", label: "Ultra reasoning" }],
        localized,
      }),
    ).toBe("Ultra reasoning");
  });
});
