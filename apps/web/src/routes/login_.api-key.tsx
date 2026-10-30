import { createFileRoute } from "@tanstack/react-router";

import { MossEnterpriseKeyPage } from "~/components/auth/MossEnterpriseKeyPage";

export const Route = createFileRoute("/login_/api-key")({
  component: MossEnterpriseKeyPage,
  head: () => ({ meta: [{ title: "企业 API Key 登录 · Moss" }] }),
});
