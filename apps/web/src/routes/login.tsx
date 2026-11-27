import { createFileRoute } from "@tanstack/react-router";

import { MossCloudLoginPage } from "~/components/auth/MossCloudAuthPages";
import { MossPhoneLoginPage } from "~/components/auth/MossPhoneAuth";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { readonly add?: true | "phone" } =>
    search.add === true || search.add === "true" || search.add === "1"
      ? { add: true }
      : search.add === "phone"
        ? { add: "phone" }
        : {},
  component: LoginRoute,
  head: () => ({ meta: [{ title: "Sign in · Moss" }] }),
});

function LoginRoute() {
  const search = Route.useSearch();
  if (search.add === true) return <MossCloudLoginPage addAccount />;
  return <MossPhoneLoginPage addPhoneLane={search.add === "phone"} />;
}
