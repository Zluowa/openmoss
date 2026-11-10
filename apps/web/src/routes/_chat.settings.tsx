// FILE: _chat.settings.tsx
// Purpose: Keep `/settings?section=…` deep links working now that Settings is a dialog:
//          open the dialog at that page and return to the screen that was showing.
// Layer: Route
// Exports: Route for `/settings`

import { createFileRoute } from "@tanstack/react-router";

import { SettingsDeepLink } from "~/components/settings/SettingsDeepLink";

export const Route = createFileRoute("/_chat/settings")({
  component: () => <SettingsDeepLink pathname="/settings" />,
});
