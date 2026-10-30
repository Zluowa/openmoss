// FILE: _chat.skills.plugins.$pluginId.tsx
// Purpose: Browse-context plugin detail route.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/skills/plugins/$pluginId")({
  component: PluginLibrary,
});
