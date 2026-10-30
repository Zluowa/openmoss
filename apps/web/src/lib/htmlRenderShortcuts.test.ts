import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@synara/contracts";
import { compileKeybindingRule } from "@synara/shared/keybindingRules";
import { describe, expect, it } from "vitest";

import { htmlRenderShortcutPolicy, isHtmlRenderShortcut } from "./htmlRenderShortcuts";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

const bindings = (rules: ReadonlyArray<[key: string, command: KeybindingCommand]>) =>
  rules.map(([key, command]) => {
    const rule = compileKeybindingRule({ key, command });
    if (rule === null) throw new Error(`Invalid test binding ${key}`);
    return rule;
  }) satisfies ResolvedKeybindingsConfig;

const press = (key: string, code: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean }) => ({
  key,
  code,
  metaKey: modifiers.metaKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  shiftKey: false,
  altKey: false,
  repeat: false,
});

describe("htmlRenderShortcutPolicy", () => {
  it("forwards only Cmd/Ctrl chords of view commands, with mod resolved per platform", () => {
    const keybindings = bindings([
      ["mod+b", "sidebar.toggle"],
      ["f", "chat.find"],
      ["mod+shift+o", "chat.new"],
    ]);
    const mac = htmlRenderShortcutPolicy(keybindings, MAC);
    expect(mac.shortcuts).toContainEqual({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    // A plain key belongs to the page; a thread-changing command is never forwarded.
    expect(mac.shortcuts).not.toContainEqual({
      key: "f",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(mac.shortcuts).not.toContainEqual({
      key: "o",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    });
    expect(mac.blocked).toContainEqual({
      key: "o",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    });
    expect(htmlRenderShortcutPolicy(keybindings, LINUX).shortcuts).toContainEqual({
      key: "b",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    });
  });

  it("blocks the fallback shortcuts of commands the config leaves out", () => {
    const { blocked } = htmlRenderShortcutPolicy([], MAC);
    // thread.archive falls back to mod+alt+shift+a.
    expect(blocked).toContainEqual({
      key: "a",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
    });
  });
});

describe("isHtmlRenderShortcut", () => {
  const policy = htmlRenderShortcutPolicy(
    bindings([
      ["mod+b", "sidebar.toggle"],
      ["mod+enter", "terminal.toggle"],
      ["mod+k", "chat.find"],
      ["mod+k", "thread.archive"],
    ]),
    MAC,
  );

  it("accepts an allowed chord", () => {
    expect(isHtmlRenderShortcut(press("b", "KeyB", { metaKey: true }), policy, MAC)).toBe(true);
    expect(isHtmlRenderShortcut(press("b", "KeyB", { ctrlKey: true }), policy, MAC)).toBe(false);
  });

  it("refuses a chord another command also claims", () => {
    expect(isHtmlRenderShortcut(press("k", "KeyK", { metaKey: true }), policy, MAC)).toBe(false);
  });

  it("refuses a named key that only matches through a forged code", () => {
    const withoutEnter = htmlRenderShortcutPolicy(bindings([["mod+b", "sidebar.toggle"]]), MAC);
    expect(isHtmlRenderShortcut(press("Enter", "KeyB", { metaKey: true }), withoutEnter, MAC)).toBe(
      false,
    );
    expect(isHtmlRenderShortcut(press("Enter", "Enter", { metaKey: true }), policy, MAC)).toBe(
      true,
    );
  });
});
