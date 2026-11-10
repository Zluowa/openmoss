// FILE: _chat.apps.index.tsx
// Purpose: The 应用页 list (until the 资料空间 home lists them by kind).
// Layer: Routing

import { createFileRoute } from "@tanstack/react-router";

import { PageAppList } from "~/components/pageApps/PageAppList";

export const Route = createFileRoute("/_chat/apps/")({
  component: PageAppList,
});
