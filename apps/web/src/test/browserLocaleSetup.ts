// Global browser-suite locale pin.
//
// Moss defaults the UI to zh-CN (DEFAULT_LOCALE_OVERRIDE), while most component
// suites assert English copy. Rather than seeding each file's fixture, patch the
// settings blob at the storage boundary: every read of the app-settings key gets
// localeOverride "en" merged in (an explicit test-set override still wins), and
// an absent key reads as the English default. Writes pass through untouched, so
// settings assertions keep seeing exactly what the app persisted.
const APP_SETTINGS_KEY = "moss:app-settings:v1";

const nativeGetItem = Storage.prototype.getItem;
Storage.prototype.getItem = function (this: Storage, key: string): string | null {
  const value = nativeGetItem.call(this, key);
  if (key !== APP_SETTINGS_KEY) {
    return value;
  }
  try {
    const parsed: unknown = value === null ? null : JSON.parse(value);
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      return value;
    }
    return JSON.stringify({ localeOverride: "en", ...(parsed ?? {}) });
  } catch {
    return value;
  }
};
