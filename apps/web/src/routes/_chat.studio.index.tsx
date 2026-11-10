// FILE: _chat.studio.index.tsx
// Purpose: Legacy redirect. Hubs were removed (2026-11-10), so old /studio links open Home.
// Layer: Routing

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/studio/")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
