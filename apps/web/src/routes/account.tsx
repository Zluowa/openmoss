import { createFileRoute } from "@tanstack/react-router";

import { MossAccountPage } from "~/components/auth/MossPhoneAuth";
import { parseMossAccountRouteSearch } from "~/components/auth/mossAccountRoutes.logic";

export const Route = createFileRoute("/account")({
  validateSearch: parseMossAccountRouteSearch,
  component: AccountRoute,
  head: () => ({ meta: [{ title: "Account · Moss" }] }),
});

function AccountRoute() {
  return <MossAccountPage view={Route.useSearch().accountView} />;
}
