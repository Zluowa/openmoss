// FILE: _chat.hubs.index.tsx
// Purpose: Legacy redirect. Hubs were removed (2026-11-10), so old /hubs links open Home.
// Layer: Routing

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/hubs/")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
