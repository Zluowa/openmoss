// FILE: _chat.plugins.tsx
// Purpose: Preserves /plugins as a compatibility redirect to the canonical /skills route.
// Layer: Route
// Exports: Route

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins")({
  beforeLoad: () => {
    throw redirect({ to: "/skills", replace: true });
  },
});
