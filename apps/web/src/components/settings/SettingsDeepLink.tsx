// FILE: SettingsDeepLink.tsx
// Purpose: What `/settings?…` and `/settings/plugins-settings` render now that Settings is a
//          dialog: open the dialog at that page, then put the screen that was showing back.
//          It acts only once the address has actually committed, so a link that a newer
//          navigation already replaced can never pull the app back.
// Layer: Route support component
// Exports: SettingsDeepLink

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { settingsBackgroundHref } from "~/settingsBackground";
import { openSettings } from "~/settingsDialogStore";
import { settingsLocationFromSearch } from "~/settingsLocation";

export function SettingsDeepLink({ pathname }: { readonly pathname: string }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    openSettings(settingsLocationFromSearch(search, pathname));
    void navigate({ href: settingsBackgroundHref(), replace: true });
  }, [navigate, pathname, search]);
  return null;
}
