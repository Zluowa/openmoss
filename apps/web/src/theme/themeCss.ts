// FILE: themeCss.ts
// Purpose: Applies a theme pack's custom CSS to the document, keeping only rules that cannot
//          load a file or write text.
// Layer: Web appearance runtime
// Exports: applyThemeCss, inspectThemeCss, ThemeCssApplyResult
// Origin: Ported from apps/web/src/themeCss.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 1d1489d0b8 (PR #35247). Moss changes: the
//   declaration check also refuses text (`themeCssDeclarationBlocked`), a rule shape the guard
//   does not know is dropped even when it holds declarations, and the caller learns how many
//   declarations were dropped. See THIRD_PARTY_NOTICES.md.

import {
  THEME_IMAGE_SCHEME,
  resolveThemeCssImages,
  themeCssDeclarationBlocked,
  themeCssValueFetches,
} from "@moss/shared/themeCss";

import { themeImageUrl } from "./themeImages";

// Theme CSS comes from imported share strings and from agents, so it must not fetch: a url() on
// an attribute selector can send what is on screen to another host. The browser parses the
// text first, so the checks see normalized values and CSS escapes in a function name cannot
// dodge them. Whatever the guard cannot check is dropped.
//
// One kind of address passes besides data: and #id: a stored theme picture,
// `url(moss-theme-image:<64 hex>.<type>)`. Its shape is fixed (no host, path, query or escape),
// and once a declaration has passed the check the guard itself replaces it with Moss's own theme
// image route on the connected server (`themeImageUrl`), so the author never picks the address.

let themeSheet: CSSStyleSheet | null = null;
let appliedCss = "";
let lastResult: ThemeCssApplyResult = { droppedDeclarations: 0, droppedRules: 0 };

export interface ThemeCssApplyResult {
  /** Declarations removed because they could load a file or write text. */
  readonly droppedDeclarations: number;
  /** Rules removed whole: @import, unknown at-rules, unsafe @property and @font-face. */
  readonly droppedRules: number;
}

type RuleParent = Pick<CSSStyleSheet, "cssRules" | "deleteRule">;

// @keyframes also has both members, but its deleteRule takes a keyframe selector.
const isRuleParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  "cssRules" in rule && "deleteRule" in rule && !(rule instanceof CSSKeyframesRule);

/** Whether `rule` is an instance of the CSSOM class `name`, when this browser has that class. */
function isRuleOf(rule: CSSRule, name: string): boolean {
  const ruleClass = (globalThis as Record<string, unknown>)[name];
  return typeof ruleClass === "function" && rule instanceof ruleClass;
}

/** Rules that are only declarations: style rules, @page, and declarations nested in a rule. */
const isDeclarationRule = (rule: CSSRule): boolean =>
  rule instanceof CSSStyleRule ||
  rule instanceof CSSPageRule ||
  isRuleOf(rule, "CSSNestedDeclarations");

/** Grouping rules whose children the guard walks. Anything else holding rules is dropped. */
const isCheckedGroupingRule = (rule: CSSRule): boolean =>
  rule instanceof CSSMediaRule ||
  rule instanceof CSSSupportsRule ||
  rule instanceof CSSLayerBlockRule ||
  isRuleOf(rule, "CSSContainerRule") ||
  isRuleOf(rule, "CSSScopeRule") ||
  isRuleOf(rule, "CSSStartingStyleRule");

function stripDeclarations(rule: CSSRule, counts: { declarations: number }): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    const value = rule.style.getPropertyValue(property);
    if (themeCssDeclarationBlocked(property, value)) {
      rule.style.removeProperty(property);
      counts.declarations += 1;
    } else if (value.includes(THEME_IMAGE_SCHEME)) {
      // A checked value: only the fixed-shape references in it are replaced.
      const resolved = resolveThemeCssImages(value, themeImageUrl);
      const priority = rule.style.getPropertyPriority(property);
      rule.style.setProperty(property, resolved, priority);
      const applied = rule.style.getPropertyValue(property);
      if (applied === "" || applied.includes(THEME_IMAGE_SCHEME)) {
        rule.style.removeProperty(property);
        counts.declarations += 1;
      }
    }
  }
  return true;
}

/** Keeps only rule shapes it can check, so a new at-rule that fetches is dropped by default. */
function stripFetches(parent: RuleParent, counts: { declarations: number; rules: number }): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    if (isDeclarationRule(rule)) {
      stripDeclarations(rule, counts);
      // CSS nesting: a style rule holds nested rules of its own.
      if (isRuleParent(rule)) stripFetches(rule, counts);
    } else if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame, counts);
    } else if (isRuleParent(rule) && isCheckedGroupingRule(rule)) {
      stripFetches(rule, counts);
    } else if (rule instanceof CSSPropertyRule) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeCssValueFetches(rule.initialValue ?? "")) {
        parent.deleteRule(index);
        counts.rules += 1;
      }
    } else if (
      rule instanceof CSSLayerStatementRule ||
      // Names a namespace without loading it. CSSOM refuses to delete one while style rules remain.
      rule instanceof CSSNamespaceRule
    ) {
      continue;
    } else {
      // @import, @font-face (its src loads a file), @counter-style, @font-feature-values and
      // any at-rule a later browser adds.
      parent.deleteRule(index);
      counts.rules += 1;
    }
  }
}

/** Load `css` into `sheet` and strip it. A sheet the guard could not walk is left empty. */
function loadGuarded(sheet: CSSStyleSheet, css: string): ThemeCssApplyResult {
  const counts = { declarations: 0, rules: 0 };
  try {
    sheet.replaceSync(css);
    stripFetches(sheet, counts);
  } catch {
    // Fail closed: a sheet the guard could not walk applies nothing.
    sheet.replaceSync("");
  }
  return { droppedDeclarations: counts.declarations, droppedRules: counts.rules };
}

/** Replace the document's theme CSS. `undefined` or "" removes it. */
export function applyThemeCss(css: string | undefined): ThemeCssApplyResult {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return lastResult;
  const next = css ?? "";
  if (next === appliedCss) return lastResult;
  appliedCss = next;
  if (!themeSheet) {
    if (next.length === 0) return (lastResult = { droppedDeclarations: 0, droppedRules: 0 });
    // Adopted sheets order after the document's own, and they cannot hold @import.
    themeSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet];
  }
  lastResult = loadGuarded(themeSheet, next);
  return lastResult;
}

/**
 * What the guard would drop from `css`, without applying it: it runs on a sheet that is never
 * adopted, so this works for the inactive pack too. For the theme editor's notice.
 */
export function inspectThemeCss(css: string): ThemeCssApplyResult {
  if (css.length === 0 || typeof CSSStyleSheet === "undefined") {
    return { droppedDeclarations: 0, droppedRules: 0 };
  }
  return loadGuarded(new CSSStyleSheet(), css);
}
