// FILE: themeCssHooks.test.ts
// Purpose: Every selector the theme guide promises still exists in Moss's web source and has a
//          rendered check, and Moss's own styles never hand theme CSS a way to load a file.
// Layer: Web appearance tests (plain source scan)
// Origin: apps/web/src/themeCssHooks.test.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8 (PR #35247).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { THEME_CSS_HOOKS } from "@moss/shared/themeCss";
import { describe, expect, it } from "vitest";

import {
  CHAT_HOOKS,
  MASK_PROBED_HOOKS,
  OUTLINE_PROBED_HOOKS,
  PRIMITIVE_HOOKS,
  SETTINGS_HOOKS,
} from "../test/themeHookCoverage";

const sourceDirectory = NodePath.resolve(import.meta.dirname, "..");
const sourceFiles = NodeFS.readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.(test|browser)\./.test(file))
  .map((file) => ({
    file,
    text: NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8"),
  }));
const source = sourceFiles.map((entry) => entry.text).join("\n");

/** How the selector's hook is written in source: an attribute, a slot value, or a class name. */
function sourcePattern(selector: string): RegExp {
  const slot = /^\[data-slot="([a-z-]+)"\]$/.exec(selector)?.[1];
  if (slot) return new RegExp(`data-slot["']?\\s*[:=]\\s*["']${slot}["']`);
  const valued = /^\[(data-[a-z-]+)="([a-z-]+)"\]$/.exec(selector);
  if (valued) return new RegExp(`${valued[1]}["']?\\s*[:=]\\s*["']${valued[2]}["']`);
  const attribute = /^\[(data-[a-z-]+)/.exec(selector)?.[1];
  return new RegExp(`\\b${attribute ?? selector.slice(1)}\\b`);
}

describe("theme CSS hooks", () => {
  // Theme CSS and the agent guide rely on these selectors. Rename one in the guide too.
  it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))(
    "%s is still in the web source",
    (selector) => {
      // `[data-message-role="user"]` is set from the message's role, so match the attribute.
      const pattern = selector.startsWith("[data-message-role=")
        ? /data-message-role=/
        : sourcePattern(selector);
      expect(source).toMatch(pattern);
    },
  );

  // The source scan only shows a hook is written somewhere. Whether a rule on it shows is
  // proven on screen by the browser tests listed in test/themeHookCoverage.ts.
  it("every hook has a rendered check, and every rendered check is a hook", () => {
    const guide = THEME_CSS_HOOKS.map((hook) => hook.selector).toSorted();
    const proven = [...CHAT_HOOKS, ...SETTINGS_HOOKS, ...PRIMITIVE_HOOKS].toSorted();
    expect(proven).toEqual(guide);
    for (const selector of [...OUTLINE_PROBED_HOOKS, ...MASK_PROBED_HOOKS]) {
      expect(guide).toContain(selector);
    }
  });

  it("finds a hook that is not there", () => {
    expect(source).not.toMatch(sourcePattern("[data-theme-hook-that-does-not-exist]"));
  });

  // Theme CSS may set any custom property to a string. A Moss rule that passed one to
  // image-set() or src() would load that string as an address, past the theme guard.
  it("Moss's own styles never pass a value to image-set() or src()", () => {
    const offenders = sourceFiles
      .filter((entry) => entry.file.endsWith(".css"))
      .filter((entry) => /image-set\(|\bsrc\(\s*var\(|url\(\s*var\(/i.test(entry.text))
      .map((entry) => entry.file);
    expect(offenders).toEqual([]);
  });

  // Theme CSS may set a custom property to a string, so a Moss rule that showed one as text
  // would let a theme write words into the app.
  it("Moss's own styles never show a custom property as text", () => {
    const offenders = sourceFiles
      .filter((entry) => /content\s*:\s*[^;{}]*var\(/i.test(entry.text))
      .map((entry) => entry.file);
    expect(offenders).toEqual([]);
  });
});
