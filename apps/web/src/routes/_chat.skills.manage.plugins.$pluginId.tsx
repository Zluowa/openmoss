// FILE: _chat.skills.manage.plugins.$pluginId.tsx
// Purpose: Manage-context plugin detail route.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/skills/manage/plugins/$pluginId")({
  component: PluginLibrary,
});
