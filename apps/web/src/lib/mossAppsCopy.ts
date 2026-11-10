// FILE: mossAppsCopy.ts
// Purpose: Localize stable Apps failures without exposing provider diagnostic text.
import { translateMoss, type TranslationKey } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";

const failures: Readonly<Record<string, TranslationKey>> = {
  authentication_required: "apps.error.login",
  apps_login_account_required: "apps.error.loginAccount",
  account_recovery_required: "apps.error.recovery",
  apps_unconfigured: "apps.error.unconfigured",
  apps_credentials_required: "apps.error.credentialsRequired",
  apps_credentials_unavailable: "apps.error.credentialsUnavailable",
  account_changed: "apps.error.accountChanged",
  apps_unavailable: "apps.error.unavailable",
};

export function mossAppsErrorMessage(cause: unknown, locale: MossLocaleCode): string {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "";
  const key =
    failures[code] ??
    Object.values(failures).find(
      (candidate) => cause instanceof Error && cause.message === translateMoss("en", candidate),
    ) ??
    "apps.error.unavailable";
  return translateMoss(locale, key);
}
