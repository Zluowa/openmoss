import { createFileRoute } from "@tanstack/react-router";

import { MossCloudAuthCallbackPage } from "~/components/auth/MossCloudAuthPages";
import { parseMossCloudAuthRouteSearch } from "~/components/auth/mossCloudAuth.logic";

export const Route = createFileRoute("/auth/callback")({
  validateSearch: parseMossCloudAuthRouteSearch,
  component: MossCloudCallbackRoute,
  head: () => ({ meta: [{ title: "Completing sign in · Moss" }] }),
});

function MossCloudCallbackRoute() {
  const search = Route.useSearch();
  return <MossCloudAuthCallbackPage code={search.code} flowId={search.flowId} />;
}
