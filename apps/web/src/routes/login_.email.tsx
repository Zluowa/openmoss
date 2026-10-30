import { createFileRoute } from "@tanstack/react-router";

import { MossCloudLoginPage } from "~/components/auth/MossCloudAuthPages";

export const Route = createFileRoute("/login_/email")({
  component: MossCloudLoginPage,
  head: () => ({ meta: [{ title: "Google sign in · Moss" }] }),
});
