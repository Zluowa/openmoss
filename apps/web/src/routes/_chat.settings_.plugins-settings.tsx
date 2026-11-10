// FILE: _chat.settings_.plugins-settings.tsx
// Purpose: Keep the old Settings › Plugins address working: open the Settings dialog on
//          Plugins and return to the screen that was showing.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";

import { SettingsDeepLink } from "~/components/settings/SettingsDeepLink";

export const Route = createFileRoute("/_chat/settings_/plugins-settings")({
  component: () => <SettingsDeepLink pathname="/settings/plugins-settings" />,
});
