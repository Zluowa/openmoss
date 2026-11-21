// FILE: account.tsx
// Purpose: Keep `/account` deep links working after moving the old standalone Moss
//          account view into Settings → 账号: open the Settings dialog at `account`
//          and return to the background screen (same pattern as `/settings`).
// Layer: Route

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { parseMossAccountRouteSearch } from "~/components/auth/mossAccountRoutes.logic";
import { settingsBackgroundHref } from "~/settingsBackground";
import { openSettings } from "~/settingsDialogStore";

export const Route = createFileRoute("/account")({
  validateSearch: parseMossAccountRouteSearch,
  component: AccountRoute,
  head: () => ({ meta: [{ title: "Account · Moss" }] }),
});

function AccountRoute() {
  const { accountView } = Route.useSearch();
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    openSettings({
      section: "account",
      ...(accountView ? { accountView } : {}),
    });
    void navigate({ href: settingsBackgroundHref(), replace: true });
  }, [accountView, navigate]);

  return null;
}
