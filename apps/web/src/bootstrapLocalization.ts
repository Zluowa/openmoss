// FILE: bootstrapLocalization.ts
// Purpose: Provides localized copy before the React application bundle is loaded.
// Layer: Web bootstrap localization

import { APP_DISPLAY_NAME } from "./branding";
import {
  applyDocumentLocale,
  resolveStoredMossLocale,
  type LocaleStorage,
  type MossLocaleCode,
} from "./uiLocale";

const EN_BOOTSTRAP_TRANSLATIONS = {
  "signedOut.documentTitle": "Signed out · {appName}",
  "signedOut.eyebrow": "Session closed",
  "signedOut.title": "This browser no longer controls {appName}.",
  "signedOut.description":
    "The session and its live connections were revoked. To reconnect, generate a fresh pairing link from an active owner session and open it in this browser.",
  "pairingFailure.documentTitle": "Pairing failed · {appName}",
  "pairingFailure.eyebrow": "Secure pairing interrupted",
  "pairingFailure.title": "This pairing link could not be used.",
  "pairingFailure.description":
    "The link may be incomplete, expired, or already used. Generate a new pairing link from the {appName} server and try again.",
} as const;

export type BootstrapTranslationKey = keyof typeof EN_BOOTSTRAP_TRANSLATIONS;

const ZH_CN_BOOTSTRAP_TRANSLATIONS: Record<BootstrapTranslationKey, string> = {
  "signedOut.documentTitle": "已退出登录 · {appName}",
  "signedOut.eyebrow": "会话已关闭",
  "signedOut.title": "此浏览器已不再控制 {appName}。",
  "signedOut.description":
    "当前会话及其所有实时连接均已撤销。若要重新连接，请在仍处于活动状态的所有者会话中生成新的配对链接，并在此浏览器中打开。",
  "pairingFailure.documentTitle": "配对失败 · {appName}",
  "pairingFailure.eyebrow": "安全配对已中断",
  "pairingFailure.title": "此配对链接无法使用。",
  "pairingFailure.description":
    "链接可能不完整、已过期或已被使用。请从 {appName} 服务器生成新的配对链接后重试。",
};

const BOOTSTRAP_TRANSLATIONS: Record<MossLocaleCode, Record<BootstrapTranslationKey, string>> = {
  en: EN_BOOTSTRAP_TRANSLATIONS,
  "zh-CN": ZH_CN_BOOTSTRAP_TRANSLATIONS,
};

export function translateBootstrap(locale: MossLocaleCode, key: BootstrapTranslationKey): string {
  return BOOTSTRAP_TRANSLATIONS[locale][key].replaceAll("{appName}", APP_DISPLAY_NAME);
}

export function resolveBootstrapLocale(
  storage?: LocaleStorage,
  languages?: readonly string[],
): MossLocaleCode {
  return resolveStoredMossLocale(storage, languages);
}

export function prepareBootstrapLocalization(
  storage?: LocaleStorage,
  languages?: readonly string[],
): MossLocaleCode {
  const locale = resolveBootstrapLocale(storage, languages);
  applyDocumentLocale(locale);
  return locale;
}
