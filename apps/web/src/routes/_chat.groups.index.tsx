// FILE: _chat.groups.index.tsx
// Purpose: Legacy redirect. Hubs were removed (2026-11-10), so old /groups links open Home.
// Layer: Routing

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/groups/")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
