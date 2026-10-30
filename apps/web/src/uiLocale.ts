// FILE: uiLocale.ts
// Purpose: Resolves the renderer locale without importing React or the settings store.
// Layer: Web localization primitives

export const APP_SETTINGS_STORAGE_KEY = "moss:app-settings:v1";

export const MOSS_LOCALE_CODES = ["en", "zh-CN"] as const;
export type MossLocaleCode = (typeof MOSS_LOCALE_CODES)[number];
export type LocaleOverride = MossLocaleCode | null;

export const DEFAULT_LOCALE_OVERRIDE: MossLocaleCode = "zh-CN";

const MOSS_LOCALE_CODE_SET = new Set<string>(MOSS_LOCALE_CODES);

export function isMossLocaleCode(value: string): value is MossLocaleCode {
  return MOSS_LOCALE_CODE_SET.has(value);
}

export function normalizeLocaleOverride(value: unknown): LocaleOverride {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && isMossLocaleCode(value) ? value : DEFAULT_LOCALE_OVERRIDE;
}

function getBrowserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export function resolveMossLocale(
  localeOverride: LocaleOverride,
  languages: readonly string[] = getBrowserLanguages(),
): MossLocaleCode {
  if (localeOverride) {
    return localeOverride;
  }

  for (const language of languages) {
    const normalized = language.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === "zh" || normalized.startsWith("zh-")) {
      return "zh-CN";
    }
    if (normalized === "en" || normalized.startsWith("en-")) {
      return "en";
    }
  }

  return DEFAULT_LOCALE_OVERRIDE;
}

export type LocaleStorage = Pick<Storage, "getItem">;

function getDefaultLocaleStorage(): LocaleStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredLocaleOverride(
  storage: LocaleStorage | undefined = getDefaultLocaleStorage(),
): LocaleOverride {
  let rawSettings: string | null;
  try {
    rawSettings = storage?.getItem(APP_SETTINGS_STORAGE_KEY) ?? null;
  } catch {
    return DEFAULT_LOCALE_OVERRIDE;
  }

  if (rawSettings === null) {
    return DEFAULT_LOCALE_OVERRIDE;
  }

  try {
    const parsed = JSON.parse(rawSettings) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("localeOverride" in parsed)) {
      return DEFAULT_LOCALE_OVERRIDE;
    }
    return normalizeLocaleOverride(
      (parsed as { readonly localeOverride?: unknown }).localeOverride,
    );
  } catch {
    return DEFAULT_LOCALE_OVERRIDE;
  }
}

export function resolveStoredMossLocale(
  storage: LocaleStorage | undefined = getDefaultLocaleStorage(),
  languages: readonly string[] = getBrowserLanguages(),
): MossLocaleCode {
  return resolveMossLocale(readStoredLocaleOverride(storage), languages);
}

export function applyDocumentLocale(locale: MossLocaleCode): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;
  document.documentElement.dataset.mossLocale = locale;
}
