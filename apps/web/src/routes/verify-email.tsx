import { createFileRoute } from "@tanstack/react-router";

import { MossCloudVerifyEmailPage } from "~/components/auth/MossCloudAuthPages";
import { parseMossCloudAuthRouteSearch } from "~/components/auth/mossCloudAuth.logic";

export const Route = createFileRoute("/verify-email")({
  validateSearch: parseMossCloudAuthRouteSearch,
  component: VerifyEmailRoute,
  head: () => ({ meta: [{ title: "Verify email · Moss" }] }),
});

function VerifyEmailRoute() {
  const search = Route.useSearch();
  return <MossCloudVerifyEmailPage code={search.code} email={search.email} />;
}
