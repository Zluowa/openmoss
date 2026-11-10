// FILE: localizationPrimaryJourneyImports.test.ts
// Purpose: Smoke-checks the HEL-20 component modules after typed localization wiring.
// Layer: Web component module tests

import { describe, expect, it, vi } from "vitest";
import { translateMoss, type TranslationKey } from "./localization";

vi.stubGlobal("self", globalThis);

const [
  branchToolbar,
  composerExtras,
  contextWindow,
  projectPicker,
  rightDock,
  environmentToggle,
  chatHeader,
] = await Promise.all([
  import("./components/BranchToolbar"),
  import("./components/chat/ComposerExtrasMenu"),
  import("./components/chat/ContextWindowMeter"),
  import("./components/chat/ProjectPicker"),
  import("./components/chat/RightDock"),
  import("./components/chat/environment/EnvironmentToggle"),
  import("./components/chat/ChatHeader"),
]);

describe("HEL-20 localized primary-journey modules", () => {
  it("remain importable after visible and accessibility copy is wired", () => {
    expect(branchToolbar.RuntimeUsageControls).toBeTypeOf("function");
    expect(composerExtras.ComposerExtrasMenu).toBeTypeOf("function");
    expect(contextWindow.ContextWindowMeter).toBeTypeOf("function");
    expect(projectPicker.ProjectPicker).toBeTypeOf("object");
    expect(rightDock.RightDock).toBeTypeOf("function");
    expect(environmentToggle.EnvironmentToggle).toBeTypeOf("function");
    expect(chatHeader.ChatHeader).toBeTypeOf("function");
  });

  it("resolves actual ProjectPicker runtime copy in both locales", () => {
    const translator = (locale: "en" | "zh-CN") => (key: TranslationKey) =>
      translateMoss(locale, key);

    expect(projectPicker.resolveProjectPickerDefaultCopy(translator("en"))).toEqual({
      emptyTriggerLabel: "Work in a project",
      resetActionLabel: "Don't work in a project",
      searchPlaceholder: "Search projects",
    });
    expect(projectPicker.resolveProjectPickerDefaultCopy(translator("zh-CN"))).toEqual({
      emptyTriggerLabel: "在项目中工作",
      resetActionLabel: "不在项目中工作",
      searchPlaceholder: "搜索项目",
    });

    const rawDiagnostic = new Error("EPERM /Users/alice/private/project.json");
    expect(
      projectPicker.resolveProjectPickerErrorMessage(
        "load-folders",
        translator("zh-CN"),
        rawDiagnostic,
      ),
    ).toBe("无法加载文件夹。请重试。");
    expect(
      projectPicker.resolveProjectPickerErrorMessage(
        "open-folder-picker",
        translator("en"),
        rawDiagnostic,
      ),
    ).toBe("Unable to open the folder picker. Try again.");
  });

  it("keeps the local-folder picker open and shows safe copy on sync and async selection failures", async () => {
    const t = (key: TranslationKey) => translateMoss("zh-CN", key);
    const rawDiagnostics = [
      new Error("EPERM /Users/alice/private/project.json"),
      new Error("EACCES C:\\Users\\alice\\secret"),
    ];

    for (const [index, rawDiagnostic] of rawDiagnostics.entries()) {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSelectWorkspaceRoot =
        index === 0
          ? vi.fn(() => {
              throw rawDiagnostic;
            })
          : vi.fn(async () => {
              throw rawDiagnostic;
            });

      await projectPicker.runProjectPickerWorkspaceSelection({
        workspaceRoot: "/Users/alice/Project",
        onSelectWorkspaceRoot,
        t,
        onSuccess,
        onError,
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith("无法选择项目。请重试。");
      expect(JSON.stringify(onError.mock.calls)).not.toMatch(
        /EPERM|EACCES|alice|project\.json|secret/u,
      );
    }

    const onSuccess = vi.fn();
    const onError = vi.fn();
    await projectPicker.runProjectPickerWorkspaceSelection({
      workspaceRoot: "/Users/moss/Moss Core",
      onSelectWorkspaceRoot: vi.fn(async () => undefined),
      t,
      onSuccess,
      onError,
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
