import type { MossPayCatalog } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope, translateMoss } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";

import { MossMembershipPage } from "./MossMembershipPage";
import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
} from "./mossServerReactQuery";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));

const plus: MossPayCatalog["plans"][number] = {
  code: "plus",
  displayName: "Plus",
  monthlyPriceCny: 9_900,
  monthlyCreditLimit: 1_188,
  fiveHourCreditLimit: 0,
  weeklyCreditLimit: 0,
  standardTaskEstimate: 60,
  billingModel: "cost_budget_v1",
  monthlyTokenLimit: 0,
  monthlyRequestLimit: 0,
  modelAllowlist: [],
  monthlyRealtimeCostLimitNanoUsd: 0,
  monthlyRealtimeSessionLimit: 0,
  realtimeModelAllowlist: [],
  estimatedRealtimeMinutes: 0,
  sortOrder: 2,
};

function renderPage(catalog: MossPayCatalog, locale: MossLocaleCode): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    session: null,
    smsProvider: "aliyun",
    aliyunSmsConfigured: true,
  });
  queryClient.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
    configured: true,
    authenticated: false,
    account: null,
    session: null,
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
  });
  queryClient.setQueryData(serverMossPayCatalogQueryOptions().queryKey, catalog);
  return renderToStaticMarkup(
    <MossLocaleScope locale={locale}>
      <QueryClientProvider client={queryClient}>
        <MossMembershipPage />
      </QueryClientProvider>
    </MossLocaleScope>,
  );
}

const subscribeButton = (markup: string) =>
  /<button[^>]*data-testid="moss-membership-subscribe-plus"[^>]*>/u.exec(markup)?.[0] ?? "";

describe("Moss membership page when plans can't be bought", () => {
  it.each(["en", "zh-CN"] as const)("explains why and disables buying in %s", (locale) => {
    const markup = renderPage(
      { plans: [plus], pointPackages: [], paymentMethods: [], plansPurchasable: false },
      locale,
    );
    const message = translateMoss(locale, "mossPay.catalog.plansNotPurchasable");
    expect(renderToStaticMarkup(<>{message}</>)).not.toBe("");
    expect(markup).toContain(renderToStaticMarkup(<>{message}</>));
    expect(markup).toContain(translateMoss(locale, "mossPay.membership.notPurchasableShort"));
    expect(markup).not.toContain("Stripe");
    expect(subscribeButton(markup)).toContain('disabled=""');
  });

  it("still sells the plan when the catalog offers a rail", () => {
    const markup = renderPage(
      {
        plans: [plus],
        pointPackages: [],
        paymentMethods: [{ id: "stripe_checkout", displayName: "Stripe", kind: "hosted" }],
        plansPurchasable: true,
      },
      "en",
    );
    expect(markup).toContain("Stripe");
    expect(subscribeButton(markup)).not.toContain('disabled=""');
    expect(markup).not.toContain(translateMoss("en", "mossPay.membership.notPurchasableShort"));
  });
});
