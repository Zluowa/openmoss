// FILE: localizedError.ts
// Purpose: Lets code outside React raise an error whose reason reads in the person's
//          language. The message follows the UI language the localization provider
//          publishes on <html data-moss-locale>; the key travels with it so a React
//          surface can format it again in its own locale.
// Layer: Web lib
// Exports: LocalizedError, localizedMessage, describeLocalizedError

import { formatMossTranslation, type TranslationKey } from "~/localization";
import { isMossLocaleCode, type MossLocaleCode } from "~/uiLocale";

type TranslationValues = Readonly<Record<string, string | number>>;

function currentUiLocale(): MossLocaleCode {
  const declared =
    typeof document === "undefined" ? undefined : document.documentElement.dataset.mossLocale;
  return declared !== undefined && isMossLocaleCode(declared) ? declared : "en";
}

/** A translated string in the current UI language, for code that cannot use the hook. */
export function localizedMessage(key: TranslationKey, values: TranslationValues = {}): string {
  return formatMossTranslation(currentUiLocale(), key, { ...values });
}

export class LocalizedError extends Error {
  readonly key: TranslationKey;
  readonly values: TranslationValues;

  constructor(key: TranslationKey, values: TranslationValues = {}) {
    super(localizedMessage(key, values));
    this.name = "LocalizedError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.key = key;
    this.values = values;
  }
}

/** The reason to show for a failure: the error's own reason when it has one, else `fallbackKey`. */
export function describeLocalizedError(
  error: unknown,
  format: (key: TranslationKey, values: Record<string, string | number>) => string,
  fallbackKey: TranslationKey,
): string {
  return error instanceof LocalizedError
    ? format(error.key, { ...error.values })
    : format(fallbackKey, {});
}
