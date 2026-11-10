// FILE: settingsBackground.ts
// Purpose: Remember the last screen that was not a settings address, so a `/settings`
//          deep link can open the Settings dialog over it instead of over a blank page.
// Layer: Routing support
// Exports: isSettingsPathname, rememberSettingsBackground, settingsBackgroundHref

let backgroundHref: string | null = null;

export function isSettingsPathname(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return normalized === "/settings" || normalized.startsWith("/settings/");
}

export function rememberSettingsBackground(pathname: string, href: string): void {
  if (!isSettingsPathname(pathname)) backgroundHref = href;
}

export function settingsBackgroundHref(): string {
  return backgroundHref ?? "/";
}
