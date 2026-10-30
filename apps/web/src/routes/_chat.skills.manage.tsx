// FILE: _chat.skills.manage.tsx
// Purpose: Path parent for the Skills & Apps manage route family.
// Layer: Route

import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/skills/manage")({
  component: Outlet,
});
