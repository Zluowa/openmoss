import { createFileRoute } from "@tanstack/react-router";

import { MossCloudLoginPage } from "~/components/auth/MossCloudAuthPages";
import { MossPhoneLoginPage } from "~/components/auth/MossPhoneAuth";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { readonly add?: true } =>
    search.add === true || search.add === "true" || search.add === "1" ? { add: true } : {},
  component: LoginRoute,
  head: () => ({ meta: [{ title: "Sign in · Moss" }] }),
});

function LoginRoute() {
  const search = Route.useSearch();
  return search.add === true ? <MossCloudLoginPage addAccount /> : <MossPhoneLoginPage />;
}
