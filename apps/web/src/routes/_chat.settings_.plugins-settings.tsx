// FILE: _chat.settings_.plugins-settings.tsx
// Purpose: Render Codex-compatible plugin management at /settings/plugins-settings.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";

import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/settings_/plugins-settings")({
  component: PluginLibrary,
});
