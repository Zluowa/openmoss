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
// Ways a declaration's final value could differ from what the guard read, and how each is
// closed: a shorthand holding var() reads "" per longhand (the declared text is checked too,
// `readDeclarations`); var(), env() and attr() resolve after the check (dropped in any property
// that can take an address, `acceptsAddress`, and in every text property); escapes (decoded by
// the parser; any backslash left is dropped); custom properties used elsewhere (checked where
// declared, and every use is checked again); @property initial values (checked, else the rule
// goes); nested and grouping rules (walked; unknown kinds dropped); keyframes (each frame
// checked); and anything the guard cannot read back (the block is emptied).
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

// A value the guard cannot see the end of: var() and env() are replaced at use, after the guard
// has read the declaration, and attr() copies what the page holds.
const LATE_RESOLVED = /\b(?:var|env|attr)\(/i;

const addressPropertyCache = new Map<string, boolean>();

/**
 * Whether `property` can take an address (an image, a url() reference, a cursor). Asked of the
 * browser itself, so a property a later release adds is covered too. A late-resolved value in
 * such a property is dropped: the guard cannot know what it becomes, and a custom property the
 * app sets inline (outside theme CSS) could hold another host's address.
 */
function acceptsAddress(property: string): boolean {
  const cached = addressPropertyCache.get(property);
  if (cached !== undefined) return cached;
  const accepts =
    typeof CSS === "undefined" || typeof CSS.supports !== "function"
      ? true
      : ["url(data:,x)", "url(data:,x), auto", "url(data:,x) 1"].some((value) =>
          CSS.supports(property, value),
        );
  addressPropertyCache.set(property, accepts);
  return accepts;
}

/** Whether a client drops this declaration: it could load a file or write text. */
function declarationBlocked(property: string, value: string): boolean {
  if (themeCssDeclarationBlocked(property, value)) return true;
  if (property.startsWith("--")) return false; // inert until used; every use is checked
  return LATE_RESOLVED.test(value) && acceptsAddress(property);
}

/**
 * The declarations of a style block as the browser serialises them: one entry per declared
 * property, shorthands included. A shorthand that holds var() keeps its own text here while
 * each of its longhands reads "" through getPropertyValue(), so a check of the longhands alone
 * sees nothing (`background: var(--z) url(https://…)` passed that way). Null when the text
 * cannot be split, and the caller then drops the whole block.
 */
function readDeclarations(
  cssText: string,
): Array<{ readonly property: string; readonly value: string }> | null {
  const declarations: Array<{ property: string; value: string }> = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  const flush = () => {
    const text = current.trim();
    current = "";
    if (text.length === 0) return true;
    const colon = text.indexOf(":");
    if (colon <= 0) return false;
    const name = text.slice(0, colon).trim();
    const property = name.startsWith("--") ? name : name.toLowerCase();
    const value = text
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, "")
      .trim();
    declarations.push({ property, value });
    return true;
  };
  for (let index = 0; index < cssText.length; index++) {
    const char = cssText[index]!;
    current += char;
    if (quote) {
      if (char === "\\") {
        current += cssText[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      current = current.slice(0, -1);
      if (!flush()) return null;
    }
  }
  if (quote || depth !== 0) return null;
  return flush() ? declarations : null;
}

function stripDeclarations(rule: CSSRule, counts: { declarations: number }): boolean {
  if (!("style" in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  const style = rule.style;
  // 1. Every declaration as declared, shorthands with late-resolved values included.
  const declared = readDeclarations(style.cssText);
  if (declared === null) {
    counts.declarations += Math.max(1, style.length);
    style.cssText = "";
    return true;
  }
  for (const { property, value } of declared) {
    if (declarationBlocked(property, value)) {
      style.removeProperty(property);
      counts.declarations += 1;
    }
  }
  // 2. Every longhand as the browser resolved it.
  for (let item = style.length - 1; item >= 0; item--) {
    const property = style.item(item);
    if (declarationBlocked(property, style.getPropertyValue(property))) {
      style.removeProperty(property);
      counts.declarations += 1;
    }
  }
  // 3. Fail closed: whatever is left must read back as declarations the checks accept.
  const left = readDeclarations(style.cssText);
  if (left === null || left.some(({ property, value }) => declarationBlocked(property, value))) {
    counts.declarations += Math.max(1, style.length);
    style.cssText = "";
    return true;
  }
  // 4. Only now, on checked declarations, a stored picture reference becomes Moss's own theme
  // image address. A value with a reference has no var() (step 1 drops it in any property that
  // takes an address), so every longhand reads its own value here.
  for (let item = style.length - 1; item >= 0; item--) {
    const property = style.item(item);
    const value = style.getPropertyValue(property);
    if (!value.includes(THEME_IMAGE_SCHEME)) continue;
    const resolved = resolveThemeCssImages(value, themeImageUrl);
    style.setProperty(property, resolved, style.getPropertyPriority(property));
    const applied = style.getPropertyValue(property);
    if (applied === "" || applied.includes(THEME_IMAGE_SCHEME)) {
      style.removeProperty(property);
      counts.declarations += 1;
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
