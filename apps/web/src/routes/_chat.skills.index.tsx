// FILE: _chat.skills.index.tsx
// Purpose: Canonical plugin and skill browse entry at /skills with Codex Customize secondary.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";
import { PluginLibrary } from "~/components/PluginLibrary";

export const Route = createFileRoute("/_chat/skills/")({
  component: PluginLibrary,
});
