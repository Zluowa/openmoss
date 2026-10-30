export const APP_BASE_NAME = "Moss";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "moss-canary:";
const isBetaDesktop = typeof window !== "undefined" && window.location?.protocol === "moss-beta:";
export const APP_DISPLAY_NAME = isCanaryDesktop
  ? "Moss Canary"
  : isBetaDesktop
    ? "Moss Beta"
    : import.meta.env.DEV
      ? `${APP_BASE_NAME} (Dev)`
      : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
