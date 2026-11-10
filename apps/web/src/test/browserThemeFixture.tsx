// Real theme-store fixture shared by browser screenshot suites. A root class alone
// is overwritten as soon as a component subscribes to useTheme.
import type { ReactNode } from "react";

import { resetThemeSnapshotCacheForTests, useTheme } from "../hooks/useTheme";
import { DEFAULT_THEME_STATE, serializeThemeState, type ThemeVariant } from "../theme/theme.logic";

export function BrowserThemeFixture({ children }: { children: ReactNode }) {
  useTheme();
  return <>{children}</>;
}

export function installBrowserFixtureTheme(theme: ThemeVariant): () => void {
  const previous = localStorage.getItem("moss:theme");
  localStorage.setItem("moss:theme", serializeThemeState({ ...DEFAULT_THEME_STATE, mode: theme }));
  resetThemeSnapshotCacheForTests();
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  return () => {
    if (previous === null) localStorage.removeItem("moss:theme");
    else localStorage.setItem("moss:theme", previous);
    resetThemeSnapshotCacheForTests();
    window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  };
}
