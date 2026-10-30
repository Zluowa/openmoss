import { createFileRoute } from "@tanstack/react-router";

import { MossCloudResetPasswordPage } from "~/components/auth/MossCloudAuthPages";
import { parseMossCloudAuthRouteSearch } from "~/components/auth/mossCloudAuth.logic";

export const Route = createFileRoute("/reset-password")({
  validateSearch: parseMossCloudAuthRouteSearch,
  component: ResetPasswordRoute,
  head: () => ({ meta: [{ title: "Choose a new password · Moss" }] }),
});

function ResetPasswordRoute() {
  const search = Route.useSearch();
  return <MossCloudResetPasswordPage code={search.code} />;
}
