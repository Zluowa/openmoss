// FILE: _chat.apps.$appId.tsx
// Purpose: Full view of one 应用页.
// Layer: Routing

import { createFileRoute } from "@tanstack/react-router";

import { AppPageFrame } from "~/components/pageApps/AppPageFrame";

function AppPageRoute() {
  const { appId } = Route.useParams();
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* Nothing sits above this view, so the frame's header is the window's top bar. */}
      <AppPageFrame appPageId={appId} mode="full" topBar />
    </div>
  );
}

export const Route = createFileRoute("/_chat/apps/$appId")({
  component: AppPageRoute,
});
