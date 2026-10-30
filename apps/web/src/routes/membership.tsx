// FILE: membership.tsx
// Purpose: Authenticated, sidebar-free Moss membership and credit purchase route.

import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
} from "~/components/auth/mossServerReactQuery";

import { MossMembershipPage, type MossMembershipFocus } from "~/components/auth/MossMembershipPage";
import { shouldGuardMossCloudAccountRoute } from "~/components/auth/mossCloudAuthRoutes.logic";

export interface MembershipSearch {
  readonly focus: MossMembershipFocus;
}

function MembershipRouteView() {
  const { focus } = Route.useSearch();
  return <MossMembershipPage initialFocus={focus} />;
}

export const Route = createFileRoute("/membership")({
  validateSearch: (search: Record<string, unknown>): MembershipSearch => ({
    focus: search.focus === "credits" ? "credits" : "plans",
  }),
  beforeLoad: async ({ context }) => {
    const [accountState, phoneState] = await Promise.all([
      // A temporary WebSocket read failure must not turn navigation into the
      // generic root error page. The route guard handles an unavailable cloud
      // account state conservatively while the transport reconnects.
      context.queryClient
        .ensureQueryData(serverMossCloudAccountStateQueryOptions())
        .catch(() => null),
      context.queryClient.ensureQueryData(serverMossAccountSessionQueryOptions()).catch(() => null),
    ]);
    if (shouldGuardMossCloudAccountRoute(accountState, phoneState)) {
      throw redirect({ to: "/login" });
    }
  },
  component: MembershipRouteView,
  head: () => ({ meta: [{ title: "Membership · Moss" }] }),
});
