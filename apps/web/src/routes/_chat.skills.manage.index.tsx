// FILE: _chat.skills.manage.index.tsx
// Purpose: Codex-compatible extension management page at /skills/manage.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/skills/manage/")({
  component: PluginLibrary,
});
