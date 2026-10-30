import { useQuery } from "@tanstack/react-query";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "./mossServerReactQuery";
import { Link } from "@tanstack/react-router";

import { MossLogo } from "~/components/MossLogo";

import { useTranslation } from "~/localization";

export function MossCloudAccountEntry() {
  const { format, t } = useTranslation();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountsQuery = useQuery(serverMossCloudAccountsQueryOptions());
  const enterpriseQuery = useQuery(serverMossEnterpriseKeyStateQueryOptions());
  const phoneQuery = useQuery(serverMossAccountSessionQueryOptions());
  const state = accountQuery.data;
  const phoneSession = phoneQuery.data?.session;
  const savedAccountCount = accountsQuery.data?.accounts.length ?? 0;
  const hasAccount = Boolean(phoneSession || state?.authenticated || savedAccountCount > 0);
  const hasAccountSnapshot =
    state !== undefined || phoneQuery.data !== undefined || savedAccountCount > 0;
  const destination = hasAccount ? "/account" : "/login";
  const status = phoneSession
    ? phoneSession.user.phoneNumber
    : state?.authenticated && state.account
      ? state.account.email
      : savedAccountCount > 0
        ? format(
            savedAccountCount === 1
              ? "settings.account.entry.savedAccount.one"
              : "settings.account.entry.savedAccount.many",
            { count: savedAccountCount },
          )
        : !hasAccountSnapshot && (accountQuery.isPending || phoneQuery.isPending)
          ? t("settings.account.entry.checking")
          : !hasAccountSnapshot && (accountQuery.isError || phoneQuery.isError)
            ? t("settings.account.entry.unavailable")
            : state?.configured === false && phoneQuery.data?.configured === false
              ? t("settings.account.entry.signInUnavailable")
              : t("settings.account.entry.signedOut");

  const enterpriseStatus = enterpriseQuery.data
    ? enterpriseQuery.data.authenticated
      ? enterpriseQuery.data.active
        ? t("settings.account.entry.keyInUse")
        : t("settings.account.entry.keySaved")
      : t("settings.account.entry.addKey")
    : enterpriseQuery.isPending
      ? t("settings.account.entry.checkingKey")
      : t("settings.account.entry.keyUnavailable");

  return (
    <div className="grid min-w-0 gap-3">
      <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/60 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60">
            <MossLogo className="size-6" />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-lg font-medium">{t("settings.account.entry.accountHeading")}</h2>
            <p className="mt-0.5 truncate text-ui-lg text-muted-foreground">{status}</p>
          </div>
        </div>
        <Link
          className="inline-flex min-h-8 shrink-0 items-center rounded-lg border border-border px-3 text-ui-lg font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={
            hasAccount
              ? t("settings.account.entry.manageAccountAria")
              : t("settings.account.entry.openAccountAria")
          }
          to={destination}
        >
          {hasAccount ? t("settings.account.entry.manage") : t("settings.account.entry.open")}
        </Link>
      </section>
      <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/60 p-4">
        <div className="min-w-0">
          <h2 className="text-ui-lg font-medium">{t("settings.account.entry.keyHeading")}</h2>
          <p className="mt-0.5 truncate text-ui-lg text-muted-foreground">{enterpriseStatus}</p>
        </div>
        <Link
          className="inline-flex min-h-8 shrink-0 items-center rounded-lg border border-border px-3 text-ui-lg font-medium outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={t("settings.account.entry.manageKeyAria")}
          to="/login/api-key"
        >
          {t("settings.account.entry.manage")}
        </Link>
      </section>
    </div>
  );
}
