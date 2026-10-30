import type {
  MossPayCatalog,
  MossPayCreateOrderInput,
  MossPayGetOrderInput,
  MossPayOrder,
  MossPayQuota,
} from "@synara/contracts";
import { MossPayMediaTopupPackage, MossPayMediaWallet, MossMediaNanoCny } from "@synara/contracts";
import { MOSS_CLOUD_REGION_HEADER } from "@synara/shared/mossProductionPublicConfig";
import { Effect, Layer, Schema } from "effect";

import { MossPhoneAccountService } from "../Services/MossPhoneAccountService";
import type {
  MossMemFirePhoneAuthorityCredential,
  MossPhoneAccountServiceShape,
} from "../Services/MossPhoneAccountService";
import { MossCloudAccountService } from "../Services/MossCloudAccountService";
import type {
  MossCloudAccountServiceShape,
  MossSupabaseGoogleAuthorityCredential,
} from "../Services/MossCloudAccountService";
import { MossAccountServiceError } from "../mossAccountErrors";
import { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import { MossPayError, mossPayFetch } from "../mossPayGateway";
import { MossPayService } from "../Services/MossPayService";
import { isTrustedMossManagedGatewayUrlForAuthority } from "../../provider/mossManagedGatewayTrust";

const SAFE_MOSS_PAY_ERROR_MESSAGES = {
  not_configured: "The Moss payment service is not configured on this server.",
  unauthorized: "A valid Moss account session is required to use payments.",
  gateway_unavailable: "The Moss payment service is unreachable right now.",
  gateway_error: "The Moss payment request failed.",
  checkout_retry_expired:
    "This checkout request expired. Close it and start a new top-up to continue.",
  invalid_response: "The Moss payment service returned an invalid response.",
} as const;

export const sanitizeMossPayError = (cause: unknown): MossPayError => {
  if (cause instanceof MossPayError) {
    return new MossPayError({
      code: cause.code,
      ...(cause.realm === undefined ? {} : { realm: cause.realm }),
      message:
        cause.code === "not_configured" && cause.realm === "memfire-phone"
          ? "微信支付暂不可用，请稍后重试。"
          : SAFE_MOSS_PAY_ERROR_MESSAGES[cause.code],
    });
  }
  const authenticationFailure =
    cause instanceof MossCloudAccountServiceError || cause instanceof MossAccountServiceError;
  const temporarilyUnavailable =
    (cause instanceof MossCloudAccountServiceError && cause.code === "network_error") ||
    (cause instanceof MossAccountServiceError &&
      cause.code === "authentication_service_unavailable");
  return new MossPayError({
    code: temporarilyUnavailable
      ? "gateway_unavailable"
      : authenticationFailure
        ? "unauthorized"
        : "gateway_error",
    message: temporarilyUnavailable
      ? SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_unavailable
      : authenticationFailure
        ? SAFE_MOSS_PAY_ERROR_MESSAGES.unauthorized
        : SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_error,
  });
};

const toMossPayError = sanitizeMossPayError;

/**
 * Resolves exactly one account credential for a payment/quota request. The
 * phone service serializes validation and token resolution, avoiding an
 * identity-switch race. Cloud is consulted only for a typed signed-out result;
 * transient or persistence failures never substitute another credential.
 */
export type MossPayAuthorityCredential =
  | MossMemFirePhoneAuthorityCredential
  | MossSupabaseGoogleAuthorityCredential;

export function resolveMossPayAuthorityCredential(input: {
  readonly phoneAccount: Pick<MossPhoneAccountServiceShape, "getAuthorityCredential">;
  readonly cloudAccount: Pick<MossCloudAccountServiceShape, "getAuthorityCredential">;
}): Effect.Effect<
  MossPayAuthorityCredential,
  MossAccountServiceError | MossCloudAccountServiceError
> {
  return input.phoneAccount.getAuthorityCredential().pipe(
    Effect.flatMap((credential) =>
      credential.realm === "memfire-phone"
        ? Effect.succeed<MossPayAuthorityCredential>(credential)
        : Effect.fail(
            new MossAccountServiceError({
              code: "invalid_authentication_response",
              message: "The phone account authority is invalid.",
            }),
          ),
    ),
    Effect.catch(
      (
        error,
      ): Effect.Effect<
        MossPayAuthorityCredential,
        MossAccountServiceError | MossCloudAccountServiceError
      > =>
        error.code !== "authentication_required"
          ? Effect.fail(error)
          : input.cloudAccount.getAuthorityCredential().pipe(
              Effect.flatMap((credential) =>
                credential.realm === "supabase-google"
                  ? Effect.succeed<MossPayAuthorityCredential>(credential)
                  : Effect.fail(
                      new MossCloudAccountServiceError({
                        code: "provider_error",
                        message: "The Google account authority is invalid.",
                      }),
                    ),
              ),
            ),
    ),
  );
}

const asArray = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
    : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const firstDefined = (...values: ReadonlyArray<unknown>): unknown =>
  values.find((value) => value !== undefined && value !== null);

const asSafeString = (value: unknown, maxLength = 80): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
};

const asIsoDateTime = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const asNonNegativeInteger = (value: unknown, fallback = 0): number => {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const asNonNegativeNumber = (value: unknown, fallback = 0): number => {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const asNullableNonNegativeInteger = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const asPositiveInteger = (value: unknown): number | null => {
  const parsed = asNullableNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = asSafeString(entry, 200);
        return normalized === null ? [] : [normalized];
      })
    : [];

const asQuotaPolicyMode = (value: unknown): "metered" | "unlimited" | "unavailable" =>
  value === "metered" || value === "unlimited" ? value : "unavailable";

const WEIGHTED_PLAN_FALLBACKS = {
  basic: { monthly: 87, fiveHour: 12, weekly: 24, tasks: 30 },
  plus: { monthly: 174, fiveHour: 24, weekly: 48, tasks: 60 },
  pro: { monthly: 435, fiveHour: 60, weekly: 120, tasks: 150 },
  max: { monthly: 1_044, fiveHour: 144, weekly: 288, tasks: 360 },
} as const;

function creditLimitFromPlanRow(
  row: Record<string, unknown>,
  directSnakeKey: string,
  directCamelKey: string,
  microsKey: string,
  fallback: number,
): number {
  const direct = firstDefined(row[directSnakeKey], row[directCamelKey]);
  if (direct !== undefined) return asNonNegativeNumber(direct, fallback);
  const micros = asNonNegativeNumber(row[microsKey], Number.NaN);
  return Number.isNaN(micros) ? fallback : micros / 1_000_000;
}

function weightedPlanPolicy(code: string, row: Record<string, unknown>) {
  const fallback = WEIGHTED_PLAN_FALLBACKS[code as keyof typeof WEIGHTED_PLAN_FALLBACKS] ?? {
    monthly: 0,
    fiveHour: 0,
    weekly: 0,
    tasks: 0,
  };
  const isCostBudgetV1 = row.billing_model === "cost_budget_v1";
  const isWeightedV1 = row.billing_model === "weighted_credits_v1";
  const costCentLimit = (key: string, fallbackValue: number): number => {
    const nanoUsd = asNonNegativeNumber(row[key], Number.NaN);
    return Number.isNaN(nanoUsd) ? fallbackValue : nanoUsd / 10_000_000;
  };
  return {
    billingModel: isCostBudgetV1 ? ("cost_budget_v1" as const) : ("weighted_credits_v1" as const),
    monthlyCreditLimit: isCostBudgetV1
      ? costCentLimit("monthly_service_cost_limit_nano_usd", fallback.monthly)
      : isWeightedV1
        ? creditLimitFromPlanRow(
            row,
            "monthly_credit_limit",
            "monthlyCreditLimit",
            "monthly_credit_limit_micros",
            fallback.monthly,
          )
        : fallback.monthly,
    fiveHourCreditLimit: isCostBudgetV1
      ? costCentLimit("five_hour_service_cost_limit_nano_usd", fallback.fiveHour)
      : isWeightedV1
        ? creditLimitFromPlanRow(
            row,
            "five_hour_credit_limit",
            "fiveHourCreditLimit",
            "five_hour_credit_limit_micros",
            fallback.fiveHour,
          )
        : fallback.fiveHour,
    weeklyCreditLimit: isCostBudgetV1
      ? costCentLimit("weekly_service_cost_limit_nano_usd", fallback.weekly)
      : isWeightedV1
        ? creditLimitFromPlanRow(
            row,
            "weekly_credit_limit",
            "weeklyCreditLimit",
            "weekly_credit_limit_micros",
            fallback.weekly,
          )
        : fallback.weekly,
    standardTaskEstimate:
      isWeightedV1 || isCostBudgetV1
        ? asNonNegativeInteger(row.standard_task_estimate, fallback.tasks)
        : fallback.tasks,
  };
}

export function paymentMethodsForRealm(
  realm: MossPayAuthorityCredential["realm"],
): MossPayCatalog["paymentMethods"] {
  return realm === "supabase-google"
    ? [{ id: "stripe_checkout", displayName: "Stripe", kind: "hosted" }]
    : [{ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" }];
}

export function normalizeMossPayCatalogPayload(
  json: Record<string, unknown>,
  paymentMethods: MossPayCatalog["paymentMethods"],
): MossPayCatalog {
  return {
    paymentMethods,
    plans: asArray(json.plans)
      .map((plan) => {
        const code = String(plan.code ?? "");
        const canonicalDisplayName = (
          { basic: "Basic", plus: "Plus", pro: "Pro", max: "Max" } as const
        )[code as "basic" | "plus" | "pro" | "max"];
        return {
          code,
          displayName:
            canonicalDisplayName ??
            String(plan.display_name ?? plan.displayName ?? plan.code ?? ""),
          monthlyPriceCny: Number(plan.monthly_price_cny ?? plan.monthlyPriceCny ?? 0),
          ...weightedPlanPolicy(code, plan),
          monthlyTokenLimit: Number(plan.monthly_token_limit ?? plan.monthlyTokenLimit ?? 0),
          monthlyRequestLimit: Number(plan.monthly_request_limit ?? plan.monthlyRequestLimit ?? 0),
          modelAllowlist: Array.isArray(plan.model_allowlist)
            ? plan.model_allowlist.map(String)
            : [],
          monthlyRealtimeCostLimitNanoUsd: Number(
            plan.monthly_realtime_cost_limit_nano_usd ?? plan.monthlyRealtimeCostLimitNanoUsd ?? 0,
          ),
          monthlyRealtimeSessionLimit: Number(
            plan.monthly_realtime_session_limit ?? plan.monthlyRealtimeSessionLimit ?? 0,
          ),
          realtimeModelAllowlist: Array.isArray(plan.realtime_model_allowlist)
            ? plan.realtime_model_allowlist.map(String)
            : [],
          estimatedRealtimeMinutes: Number(
            plan.estimated_realtime_minutes ?? plan.estimatedRealtimeMinutes ?? 0,
          ),
          sortOrder: Number(plan.sort_order ?? plan.sortOrder ?? 0),
        };
      })
      .filter((plan) => plan.code.length > 0 && plan.monthlyPriceCny > 0),
    // Legacy point SKUs are not cost-backed and must remain unavailable even
    // while one regional catalog is waiting for the database migration.
    pointPackages: [],
    ...normalizeMediaCatalog(json, paymentMethods[0]?.id),
  };
}

function normalizeMediaCatalog(
  json: Record<string, unknown>,
  rail: string | undefined,
): Pick<MossPayCatalog, "mediaTopupPackages" | "mediaWallet"> {
  if (json.media_topup_packages === undefined && json.media_wallet === undefined) return {};
  if (!Array.isArray(json.media_topup_packages)) throw invalidAuthorityResponse();
  try {
    const packages = json.media_topup_packages.map((value) => {
      const row = value as Record<string, unknown>;
      const item = Schema.decodeUnknownSync(MossPayMediaTopupPackage)({
        code: row.code,
        displayName: row.display_name,
        currency: row.currency,
        amountMinor: row.amount_minor,
        rail: row.rail,
        available: row.available,
        creditNanoCny: row.credit_nano_cny,
        fxVersion: row.fx_version,
      });
      if (
        item.rail !== rail ||
        (rail === "wechat_pay" ? item.currency !== "CNY" : item.currency !== "USD") ||
        (item.available &&
          (item.creditNanoCny === null || item.creditNanoCny === "0" || item.fxVersion === null))
      )
        throw invalidAuthorityResponse();
      return item;
    });
    return {
      mediaTopupPackages: packages,
      mediaWallet:
        json.media_wallet === null
          ? null
          : Schema.decodeUnknownSync(MossPayMediaWallet)(json.media_wallet),
    };
  } catch (cause) {
    throw invalidAuthorityResponse(cause);
  }
}

export function parseMossPayOrder(
  json: Record<string, unknown>,
  fallback: {
    orderType: MossPayCreateOrderInput["orderType"];
    itemCode: string;
    outTradeNo?: string;
  },
  realm: MossPayAuthorityCredential["realm"],
): MossPayOrder {
  const rail =
    json.rail === "stripe_checkout" || json.rail === "wechat_pay"
      ? json.rail
      : realm === "supabase-google"
        ? "stripe_checkout"
        : "wechat_pay";
  const checkoutUrl =
    typeof json.checkout_url === "string"
      ? json.checkout_url
      : typeof json.checkoutUrl === "string"
        ? json.checkoutUrl
        : null;
  const codeUrl =
    typeof json.code_url === "string"
      ? json.code_url
      : typeof json.codeUrl === "string"
        ? json.codeUrl
        : null;
  const orderType = json.order_type ?? json.orderType ?? fallback.orderType;
  const refundReviewRequired =
    json.refund_review_required !== undefined
      ? json.refund_review_required
      : json.refundReviewRequired;
  if (refundReviewRequired !== undefined && typeof refundReviewRequired !== "boolean")
    throw invalidAuthorityResponse();
  if (fallback.orderType === "media_topup" && orderType !== "media_topup")
    throw invalidAuthorityResponse();
  if (orderType === "media_topup") {
    if (
      json.identity_realm !== realm ||
      rail !== paymentMethodsForRealm(realm)[0]?.id ||
      json.currency !== (realm === "memfire-phone" ? "CNY" : "USD") ||
      !Number.isSafeInteger(json.amount_minor) ||
      Number(json.amount_minor) <= 0 ||
      typeof json.fx_version !== "string" ||
      !json.fx_version ||
      json.credit_nano_cny === "0" ||
      (checkoutUrl !== null && !checkoutUrl.startsWith("https://")) ||
      (codeUrl !== null && !codeUrl.startsWith("weixin://"))
    )
      throw invalidAuthorityResponse();
    try {
      Schema.decodeUnknownSync(MossMediaNanoCny)(json.credit_nano_cny);
    } catch (cause) {
      throw invalidAuthorityResponse(cause);
    }
  }
  return {
    outTradeNo: String(json.out_trade_no ?? json.outTradeNo ?? fallback.outTradeNo ?? ""),
    orderType: orderType === "plan" || orderType === "media_topup" ? orderType : fallback.orderType,
    itemCode: String(json.item_code ?? json.itemCode ?? fallback.itemCode),
    amountCny: Number(json.amount_cny ?? json.amountCny ?? 0),
    amountMinor: Number(
      json.amount_minor ?? json.amountMinor ?? json.amount_cny ?? json.amountCny ?? 0,
    ),
    currency: json.currency === "USD" ? "USD" : "CNY",
    status: String(json.status ?? "pending"),
    rail,
    codeUrl: rail === "wechat_pay" ? codeUrl : null,
    checkoutUrl: rail === "stripe_checkout" ? checkoutUrl : null,
    ...(refundReviewRequired !== undefined ? { refundReviewRequired } : {}),
    ...(orderType === "media_topup"
      ? {
          mediaCreditNanoCny: String(json.credit_nano_cny),
          fxVersion: String(json.fx_version),
          identityRealm: realm,
          checkoutError: typeof json.checkout_error === "string" ? json.checkout_error : null,
        }
      : {}),
  };
}

const AUTHORITY_REST_RESPONSE_LIMIT_BYTES = 64 * 1_024;

class AuthorityMissingQuotaPolicyColumnError extends Error {
  constructor() {
    super("account_quotas quota policy column is unavailable");
    this.name = "AuthorityMissingQuotaPolicyColumnError";
  }
}

function isMissingQuotaPolicyColumnResponse(
  resource: string,
  query: URLSearchParams,
  status: number,
  body: string,
): boolean {
  if (
    resource !== "account_quotas" ||
    !query.get("select")?.split(",").includes("quota_policy_mode") ||
    (status !== 400 && status !== 422)
  ) {
    return false;
  }
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const code = value.code;
    const message = value.message;
    return (
      (code === "42703" &&
        (message === "column account_quotas.quota_policy_mode does not exist" ||
          message === "column quota_policy_mode does not exist")) ||
      (code === "PGRST204" &&
        message ===
          "Could not find the 'quota_policy_mode' column of 'account_quotas' in the schema cache")
    );
  } catch {
    return false;
  }
}

const invalidAuthorityResponse = (cause?: unknown): MossPayError =>
  new MossPayError({
    code: "invalid_response",
    message: SAFE_MOSS_PAY_ERROR_MESSAGES.invalid_response,
    ...(cause === undefined ? {} : { cause }),
  });

function requireSafeString(value: unknown, maxLength = 200): string {
  const normalized = asSafeString(value, maxLength);
  if (normalized === null) throw invalidAuthorityResponse();
  return normalized;
}

function requireIsoDateTime(value: unknown): string {
  const normalized = asIsoDateTime(value);
  if (normalized === null) throw invalidAuthorityResponse();
  return normalized;
}

function requireNonNegativeInteger(value: unknown): number {
  const normalized = asNullableNonNegativeInteger(value);
  if (normalized === null) throw invalidAuthorityResponse();
  return normalized;
}

function requireNullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  return requireNonNegativeInteger(value);
}

function requireStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) throw invalidAuthorityResponse();
  const normalized = value.map((entry) => requireSafeString(entry, 200));
  if (new Set(normalized).size !== normalized.length) throw invalidAuthorityResponse();
  return normalized;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > AUTHORITY_REST_RESPONSE_LIMIT_BYTES) {
      throw invalidAuthorityResponse();
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > AUTHORITY_REST_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw invalidAuthorityResponse();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

const PUBLIC_CATALOG_PLAN_SELECT =
  "code,display_name,monthly_price_cny,monthly_token_limit,monthly_request_limit,model_allowlist,sort_order,realtime_model_allowlist,monthly_realtime_cost_limit_nano_usd,monthly_realtime_session_limit,billing_model,monthly_credit_limit_micros,five_hour_credit_limit_micros,weekly_credit_limit_micros,monthly_service_cost_limit_nano_usd,five_hour_service_cost_limit_nano_usd,weekly_service_cost_limit_nano_usd,usage_cost_budget_bps,operating_cost_reserve_bps,gross_cost_ceiling_bps,standard_task_estimate";
const LEGACY_PUBLIC_CATALOG_PLAN_SELECT =
  "code,display_name,monthly_price_cny,monthly_token_limit,monthly_request_limit,model_allowlist,sort_order,realtime_model_allowlist,monthly_realtime_cost_limit_nano_usd,monthly_realtime_session_limit";
const PUBLIC_CATALOG_POINT_SELECT =
  "code,display_name,price_cny,points,tokens_per_point,sort_order";

function configuredPublicCatalogAuthorities(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<{ readonly baseUrl: string; readonly publishableKey: string }> {
  return [
    [env.MOSS_MEMFIRE_PHONE_URL, env.MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY],
    [env.MOSS_SUPABASE_GOOGLE_URL, env.MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY],
  ].flatMap(([rawUrl, rawKey]) => {
    const publishableKey = rawKey?.trim();
    if (!rawUrl?.trim() || !publishableKey) return [];
    try {
      const url = new URL(rawUrl);
      const path = url.pathname.replace(/\/+$/u, "") || "/";
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        path !== "/"
      ) {
        return [];
      }
      return [{ baseUrl: url.origin, publishableKey }];
    } catch {
      return [];
    }
  });
}

async function fetchPublicCatalogRows(input: {
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly resource: "moss_plans" | "moss_point_packages";
  readonly select: string;
}): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>>; readonly status: number }> {
  const url = new URL(`/rest/v1/${input.resource}`, input.baseUrl);
  url.search = new URLSearchParams({
    select: input.select,
    enabled: "eq.true",
    order: "sort_order.asc",
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: input.publishableKey,
        authorization: `Bearer ${input.publishableKey}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (cause) {
    throw new MossPayError({
      code: "gateway_unavailable",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_unavailable,
      cause,
    });
  }
  const text = await readBoundedResponseText(response);
  if (!response.ok) return { rows: [], status: response.status };
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) throw new Error("not an array");
    return {
      status: response.status,
      rows: value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      ),
    };
  } catch (cause) {
    throw invalidAuthorityResponse(cause);
  }
}

async function fetchPublicAuthorityCatalog(): Promise<MossPayCatalog> {
  let lastFailure: unknown;
  for (const authority of configuredPublicCatalogAuthorities()) {
    try {
      let plans = await fetchPublicCatalogRows({
        ...authority,
        resource: "moss_plans",
        select: PUBLIC_CATALOG_PLAN_SELECT,
      });
      if (plans.status === 400 || plans.status === 422) {
        plans = await fetchPublicCatalogRows({
          ...authority,
          resource: "moss_plans",
          select: LEGACY_PUBLIC_CATALOG_PLAN_SELECT,
        });
      }
      if (plans.status !== 200) {
        throw new MossPayError({
          code: "gateway_error",
          message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_error,
        });
      }
      const pointPackages = await fetchPublicCatalogRows({
        ...authority,
        resource: "moss_point_packages",
        select: PUBLIC_CATALOG_POINT_SELECT,
      });
      return normalizeMossPayCatalogPayload(
        {
          plans: plans.rows,
          point_packages: pointPackages.status === 200 ? pointPackages.rows : [],
        },
        [],
      );
    } catch (cause) {
      lastFailure = cause;
    }
  }
  if (lastFailure instanceof MossPayError) throw lastFailure;
  throw new MossPayError({
    code: "not_configured",
    message: SAFE_MOSS_PAY_ERROR_MESSAGES.not_configured,
  });
}

function configuredAuthorityRest(input: {
  readonly credential: MossPayAuthorityCredential;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): { readonly baseUrl: string; readonly publishableKey: string } {
  const env = input.env ?? process.env;
  const authorityUrlKey =
    input.credential.realm === "memfire-phone"
      ? "MOSS_MEMFIRE_PHONE_URL"
      : "MOSS_SUPABASE_GOOGLE_URL";
  const publishableKeyName =
    input.credential.realm === "memfire-phone"
      ? "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY"
      : "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY";
  const configuredUrlValue = env[authorityUrlKey]?.trim();
  const publishableKey = env[publishableKeyName]?.trim();
  if (!configuredUrlValue || !publishableKey) {
    throw new MossPayError({
      code: "not_configured",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.not_configured,
    });
  }

  try {
    const configuredUrl = new URL(configuredUrlValue);
    const issuer = new URL(input.credential.issuer);
    const configuredPath = configuredUrl.pathname.replace(/\/+$/u, "") || "/";
    const issuerPath = issuer.pathname.replace(/\/+$/u, "");
    if (
      configuredUrl.protocol !== "https:" ||
      issuer.protocol !== "https:" ||
      configuredUrl.username ||
      configuredUrl.password ||
      configuredUrl.search ||
      configuredUrl.hash ||
      configuredPath !== "/" ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuerPath !== "/auth/v1" ||
      issuer.origin !== configuredUrl.origin
    ) {
      throw new Error("authority mismatch");
    }
    return { baseUrl: configuredUrl.origin, publishableKey };
  } catch (cause) {
    if (cause instanceof MossPayError) throw cause;
    throw new MossPayError({
      code: "not_configured",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.not_configured,
    });
  }
}

async function fetchAuthorityRows(input: {
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly accessToken: string;
  readonly resource: string;
  readonly query: URLSearchParams;
}): Promise<ReadonlyArray<Record<string, unknown>>> {
  const url = new URL(`/rest/v1/${input.resource}`, input.baseUrl);
  url.search = input.query.toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: input.publishableKey,
        authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (cause) {
    throw new MossPayError({
      code: "gateway_unavailable",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_unavailable,
      cause,
    });
  }
  const responseText = response.ok ? null : await readBoundedResponseText(response);
  if (
    responseText !== null &&
    isMissingQuotaPolicyColumnResponse(input.resource, input.query, response.status, responseText)
  ) {
    throw new AuthorityMissingQuotaPolicyColumnError();
  }
  if (response.status === 401 || response.status === 403) {
    throw new MossPayError({
      code: "unauthorized",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.unauthorized,
    });
  }
  if (!response.ok) {
    throw new MossPayError({
      code: "gateway_error",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_error,
    });
  }
  const text = responseText ?? (await readBoundedResponseText(response));
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) throw new Error("not an array");
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  } catch (cause) {
    if (cause instanceof MossPayError) throw cause;
    throw invalidAuthorityResponse(cause);
  }
}

async function fetchAuthorityCreditUsageSnapshot(input: {
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly accessToken: string;
}): Promise<Record<string, unknown> | null> {
  const url = new URL("/rest/v1/rpc/moss_get_credit_usage_snapshot", input.baseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        apikey: input.publishableKey,
        authorization: `Bearer ${input.accessToken}`,
      },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (cause) {
    throw new MossPayError({
      code: "gateway_unavailable",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_unavailable,
      cause,
    });
  }
  const text = await readBoundedResponseText(response);
  if (response.status === 401 || response.status === 403) {
    throw new MossPayError({
      code: "unauthorized",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.unauthorized,
    });
  }
  if (!response.ok) {
    try {
      const error = JSON.parse(text) as Record<string, unknown>;
      if (
        (response.status === 404 || response.status === 400) &&
        (error.code === "PGRST202" || error.code === "42883")
      ) {
        return null;
      }
    } catch {
      // A non-JSON failure is a real authority error, not rollout fallback.
    }
    throw new MossPayError({
      code: "gateway_error",
      message: SAFE_MOSS_PAY_ERROR_MESSAGES.gateway_error,
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (cause) {
    throw invalidAuthorityResponse(cause);
  }
}

async function fetchAuthorityAccountQuota(credential: MossPayAuthorityCredential): Promise<{
  readonly account: Record<string, unknown>;
  readonly realtime: Record<string, unknown>;
}> {
  const authority = configuredAuthorityRest({ credential });
  const now = new Date().toISOString();
  const shared = {
    baseUrl: authority.baseUrl,
    publishableKey: authority.publishableKey,
    accessToken: credential.accessToken,
  };
  const [entitlements, wallets, creditUsageSnapshot] = await Promise.all([
    fetchAuthorityRows({
      ...shared,
      resource: "account_entitlements",
      query: new URLSearchParams({
        select: "id,plan_code,realtime_model_allowlist",
        product: "eq.moss",
        status: "in.(trialing,active)",
        starts_at: `lte.${now}`,
        or: `(expires_at.is.null,expires_at.gt.${now})`,
        order: "starts_at.desc",
        limit: "1",
      }),
    }),
    fetchAuthorityRows({
      ...shared,
      resource: "credit_wallets",
      query: new URLSearchParams({ select: "balance", limit: "1" }),
    }),
    fetchAuthorityCreditUsageSnapshot(shared),
  ]);
  const quotaQuery = (includePolicy: boolean) =>
    new URLSearchParams({
      select: includePolicy
        ? "id,entitlement_id,period_start,period_end,request_limit,requests_used,token_limit,quota_policy_mode,input_tokens_used,output_tokens_used,realtime_cost_limit_nano_usd,realtime_cost_used_nano_usd,realtime_cost_reserved_nano_usd,realtime_session_limit,realtime_sessions_used"
        : "id,entitlement_id,period_start,period_end,request_limit,requests_used,token_limit,input_tokens_used,output_tokens_used,realtime_cost_limit_nano_usd,realtime_cost_used_nano_usd,realtime_cost_reserved_nano_usd,realtime_session_limit,realtime_sessions_used",
      period_start: `lte.${now}`,
      period_end: `gt.${now}`,
      order: "period_start.desc",
      limit: "1",
    });
  let quotas: ReadonlyArray<Record<string, unknown>>;
  try {
    quotas = await fetchAuthorityRows({
      ...shared,
      resource: "account_quotas",
      query: quotaQuery(true),
    });
  } catch (firstFailure) {
    if (!(firstFailure instanceof AuthorityMissingQuotaPolicyColumnError)) {
      throw firstFailure;
    }
    // The first request proved only that this deployment predates the explicit
    // policy column. The fallback is a distinct network/auth operation; let
    // its real 401/5xx/timeout classification propagate to the caller.
    quotas = await fetchAuthorityRows({
      ...shared,
      resource: "account_quotas",
      query: quotaQuery(false),
    });
  }
  const entitlement = entitlements[0];
  const quota = quotas[0];
  const wallet = wallets[0];
  if (!entitlement || !quota || !wallet) throw invalidAuthorityResponse();
  const entitlementId = requireSafeString(entitlement.id);
  if (quota.entitlement_id !== entitlementId) throw invalidAuthorityResponse();
  const periodStart = requireIsoDateTime(quota.period_start);
  const periodEnd = requireIsoDateTime(quota.period_end);
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) throw invalidAuthorityResponse();
  const requestLimit = requireNullableNonNegativeInteger(quota.request_limit);
  const tokenLimit = requireNullableNonNegativeInteger(quota.token_limit);
  const inputTokens = requireNonNegativeInteger(quota.input_tokens_used);
  const outputTokens = requireNonNegativeInteger(quota.output_tokens_used);
  if (inputTokens > Number.MAX_SAFE_INTEGER - outputTokens) throw invalidAuthorityResponse();
  const tokensUsed = inputTokens + outputTokens;
  const realtimeModelAllowlist = requireStringArray(entitlement.realtime_model_allowlist);
  const quotaPolicyModeRaw = asQuotaPolicyMode(quota.quota_policy_mode);
  const isCostBudgetV1 = creditUsageSnapshot?.billing_model === "cost_budget_v1";
  const validLegacyQuotaPolicy =
    (quotaPolicyModeRaw === "unlimited" && requestLimit === null && tokenLimit === null) ||
    (quotaPolicyModeRaw === "metered" && requestLimit !== null);
  const quotaPolicyMode = isCostBudgetV1
    ? "metered"
    : validLegacyQuotaPolicy
      ? quotaPolicyModeRaw
      : quotaPolicyModeRaw === "unavailable" && requestLimit !== null
        ? "metered"
        : "unavailable";
  return {
    account: {
      plan_code: requireSafeString(entitlement.plan_code, 80),
      period_start: periodStart,
      period_end: periodEnd,
      window_id: requireSafeString(quota.id),
      token_limit: tokenLimit,
      tokens_used: tokensUsed,
      request_limit: requestLimit,
      quota_policy_mode: quotaPolicyMode,
      requests_used: requireNonNegativeInteger(quota.requests_used),
      credit_balance: requireNonNegativeInteger(wallet.balance),
      credit_usage_snapshot: creditUsageSnapshot,
    },
    realtime: {
      configured: realtimeModelAllowlist.length > 0,
      model_allowlist: realtimeModelAllowlist,
      plan_limit_nano_usd: requireNullableNonNegativeInteger(quota.realtime_cost_limit_nano_usd),
      plan_used_nano_usd: requireNonNegativeInteger(quota.realtime_cost_used_nano_usd),
      plan_reserved_nano_usd: requireNonNegativeInteger(quota.realtime_cost_reserved_nano_usd),
      session_limit: requireNullableNonNegativeInteger(quota.realtime_session_limit),
      sessions_used: requireNonNegativeInteger(quota.realtime_sessions_used),
      estimated_minutes_remaining: null,
    },
  };
}

function normalizeCreditUsageLimits(
  snapshot: Record<string, unknown>,
): MossPayQuota["usageLimits"] {
  const validKeys = new Set(["five_hour", "weekly", "monthly", "lifetime"] as const);
  return asArray(snapshot.usage_limits ?? snapshot.usageLimits).flatMap((row) => {
    const key = row.key;
    if (
      typeof key !== "string" ||
      !validKeys.has(key as "five_hour" | "weekly" | "monthly" | "lifetime")
    ) {
      return [];
    }
    const rawLimit = firstDefined(row.limit, row.credit_limit, row.creditLimit);
    const limit = rawLimit === null ? null : asNonNegativeNumber(rawLimit, Number.NaN);
    const used = asNonNegativeNumber(
      firstDefined(row.used, row.credits_used, row.creditsUsed),
      Number.NaN,
    );
    if (Number.isNaN(limit) || Number.isNaN(used)) return [];
    const rawDuration = firstDefined(row.duration_seconds, row.durationSeconds);
    return [
      {
        key: key as "five_hour" | "weekly" | "monthly" | "lifetime",
        durationSeconds: rawDuration === null ? null : asPositiveInteger(rawDuration),
        limit,
        used,
        resetsAt: asIsoDateTime(firstDefined(row.resets_at, row.resetsAt)),
      },
    ];
  });
}

/**
 * Converts the account and realtime quota payloads into a safe, provider-window-preserving
 * snapshot. The account gateway remains authoritative: no natural week or month is invented.
 */
export function normalizeMossPayQuota(
  json: Record<string, unknown>,
  realtime: Record<string, unknown> | null,
): MossPayQuota {
  const providerWindow = asRecord(firstDefined(json.quota_window, json.quotaWindow, json.window));
  const periodStart = asIsoDateTime(
    firstDefined(
      providerWindow.period_start,
      providerWindow.periodStart,
      json.period_start,
      json.periodStart,
    ),
  );
  const periodEnd = asIsoDateTime(
    firstDefined(
      providerWindow.period_end,
      providerWindow.periodEnd,
      json.period_end,
      json.periodEnd,
    ),
  );
  const explicitDurationSeconds = asPositiveInteger(
    firstDefined(
      providerWindow.duration_seconds,
      providerWindow.durationSeconds,
      json.window_duration_seconds,
      json.windowDurationSeconds,
      json.duration_seconds,
      json.durationSeconds,
    ),
  );
  const derivedDurationSeconds = (() => {
    if (periodStart === null || periodEnd === null) return null;
    const duration = (Date.parse(periodEnd) - Date.parse(periodStart)) / 1_000;
    return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
  })();
  const realtimePayload = realtime ?? {};
  const realtimeModelAllowlist = asStringArray(
    firstDefined(realtimePayload.modelAllowlist, realtimePayload.model_allowlist),
  );
  const tokenLimit = asNullableNonNegativeInteger(firstDefined(json.token_limit, json.tokenLimit));
  const requestLimit = asNullableNonNegativeInteger(
    firstDefined(json.request_limit, json.requestLimit),
  );
  const rawQuotaPolicyMode = asQuotaPolicyMode(
    firstDefined(json.quota_policy_mode, json.quotaPolicyMode),
  );
  const creditUsageSnapshot = asRecord(
    firstDefined(json.credit_usage_snapshot, json.creditUsageSnapshot),
  );
  const isCostBudgetV1 = creditUsageSnapshot.billing_model === "cost_budget_v1";
  const validLegacyQuotaPolicy =
    (rawQuotaPolicyMode === "unlimited" && requestLimit === null && tokenLimit === null) ||
    (rawQuotaPolicyMode === "metered" && requestLimit !== null);
  const quotaPolicyMode = isCostBudgetV1
    ? "metered"
    : validLegacyQuotaPolicy
      ? rawQuotaPolicyMode
      : rawQuotaPolicyMode === "unavailable" && requestLimit !== null
        ? "metered"
        : "unavailable";
  const realtimeUnlimited = quotaPolicyMode === "unlimited" && realtimeModelAllowlist.length > 0;
  const weightedUsageLimits =
    creditUsageSnapshot.billing_model === "weighted_credits_v1" || isCostBudgetV1
      ? normalizeCreditUsageLimits(creditUsageSnapshot)
      : [];
  const legacyWindowKey =
    explicitDurationSeconds !== null && Math.abs(explicitDurationSeconds - 18_000) <= 900
      ? "five_hour"
      : explicitDurationSeconds !== null && Math.abs(explicitDurationSeconds - 604_800) <= 30_240
        ? "weekly"
        : "monthly";
  const legacyUsageLimits: MossPayQuota["usageLimits"] =
    weightedUsageLimits.length > 0 || quotaPolicyMode === "unavailable"
      ? []
      : [
          {
            key: legacyWindowKey,
            durationSeconds: explicitDurationSeconds ?? derivedDurationSeconds,
            limit: quotaPolicyMode === "unlimited" ? null : tokenLimit,
            used: asNonNegativeInteger(firstDefined(json.tokens_used, json.tokensUsed)),
            resetsAt: periodEnd,
          },
        ];

  return {
    planCode: asSafeString(firstDefined(json.plan_code, json.planCode), 80),
    billingModel:
      weightedUsageLimits.length > 0
        ? isCostBudgetV1
          ? "cost_budget_v1"
          : "weighted_credits_v1"
        : "legacy_tokens",
    usageLimits: weightedUsageLimits.length > 0 ? weightedUsageLimits : legacyUsageLimits,
    quotaPolicyMode,
    periodStart,
    periodEnd,
    windowId: asSafeString(
      firstDefined(
        providerWindow.source_window_id,
        providerWindow.sourceWindowId,
        providerWindow.window_id,
        providerWindow.windowId,
        providerWindow.window_key,
        providerWindow.windowKey,
        json.source_window_id,
        json.sourceWindowId,
        json.window_id,
        json.windowId,
        json.window_key,
        json.windowKey,
      ),
      200,
    ),
    windowSource: asSafeString(
      firstDefined(
        providerWindow.source_role,
        providerWindow.sourceRole,
        providerWindow.window_source,
        providerWindow.windowSource,
        json.window_source,
        json.windowSource,
        json.source_role,
        json.sourceRole,
        json.quota_period,
        json.quotaPeriod,
        json.period_type,
        json.periodType,
      ),
      80,
    ),
    windowDurationSeconds: explicitDurationSeconds ?? derivedDurationSeconds,
    tokenLimit,
    tokensUsed: asNonNegativeInteger(firstDefined(json.tokens_used, json.tokensUsed)),
    requestLimit,
    requestsUsed: asNonNegativeInteger(firstDefined(json.requests_used, json.requestsUsed)),
    creditBalance: asNonNegativeInteger(firstDefined(json.credit_balance, json.creditBalance)),
    realtimeConfigured:
      realtimePayload.configured === true ||
      (realtimeUnlimited && realtimeModelAllowlist.length > 0),
    realtimeModelAllowlist,
    realtimeCostLimitNanoUsd: asNullableNonNegativeInteger(
      firstDefined(realtimePayload.planLimitNanoUsd, realtimePayload.plan_limit_nano_usd),
    ),
    realtimeCostUsedNanoUsd: asNonNegativeInteger(
      firstDefined(realtimePayload.planUsedNanoUsd, realtimePayload.plan_used_nano_usd),
    ),
    realtimeCostReservedNanoUsd: asNonNegativeInteger(
      firstDefined(realtimePayload.planReservedNanoUsd, realtimePayload.plan_reserved_nano_usd),
    ),
    realtimeSessionLimit: asNullableNonNegativeInteger(
      firstDefined(realtimePayload.sessionLimit, realtimePayload.session_limit),
    ),
    realtimeSessionsUsed: asNonNegativeInteger(
      firstDefined(realtimePayload.sessionsUsed, realtimePayload.sessions_used),
    ),
    realtimeEstimatedMinutesRemaining: asNullableNonNegativeInteger(
      firstDefined(
        realtimePayload.estimatedMinutesRemaining,
        realtimePayload.estimated_minutes_remaining,
      ),
    ),
  };
}

function normalizeRealtimeRelayOrigin(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function configuredRealtimeRelayOrigin(
  credential: MossPayAuthorityCredential,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const key =
    credential.realm === "memfire-phone"
      ? "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL"
      : "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL";
  const configured = normalizeRealtimeRelayOrigin(env[key]);
  const bound = normalizeRealtimeRelayOrigin(credential.realtimeRelayUrl);
  return configured && configured === bound ? bound : null;
}

async function fetchRealtimeQuota(
  credential: MossPayAuthorityCredential,
): Promise<Record<string, unknown> | null> {
  const origin = configuredRealtimeRelayOrigin(credential);
  if (!origin) return null;
  const cloudRegion = credential.realm === "memfire-phone" ? "cn" : "global";
  try {
    const response = await fetch(`${origin}/v1/realtime/quota`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${credential.accessToken}`,
        [MOSS_CLOUD_REGION_HEADER]: cloudRegion,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text) > 64 * 1_024) return null;
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.cloudRegion === cloudRegion ? record : null;
  } catch {
    return null;
  }
}

export const MossPayServiceLive = Layer.effect(
  MossPayService,
  Effect.gen(function* () {
    const cloudAccount = yield* MossCloudAccountService;
    const phoneAccount = yield* MossPhoneAccountService;

    const withGateway = <A>(
      fn: (input: {
        modelGatewayUrl: string;
        accessToken: string;
        credential: MossPayAuthorityCredential;
      }) => Promise<A>,
    ): Effect.Effect<A, MossPayError> =>
      Effect.gen(function* () {
        const credential = yield* resolveMossPayAuthorityCredential({
          phoneAccount,
          cloudAccount,
        }).pipe(Effect.mapError(toMossPayError));
        if (
          !isTrustedMossManagedGatewayUrlForAuthority(credential.gatewayBaseUrl, credential.realm)
        ) {
          return yield* Effect.fail(
            new MossPayError({
              code: "not_configured",
              message: SAFE_MOSS_PAY_ERROR_MESSAGES.not_configured,
            }),
          );
        }
        return yield* Effect.tryPromise({
          try: () =>
            fn({
              modelGatewayUrl: credential.gatewayBaseUrl,
              accessToken: credential.accessToken,
              credential,
            }),
          catch: toMossPayError,
        });
      });

    const getCatalog = (): Effect.Effect<MossPayCatalog, MossPayError> => {
      const publicCatalog = () =>
        Effect.tryPromise({
          try: fetchPublicAuthorityCatalog,
          catch: toMossPayError,
        });
      const regionalGatewayCatalog = () =>
        withGateway(async ({ modelGatewayUrl, accessToken, credential }) => {
          const json = await mossPayFetch({
            realm: credential.realm,
            modelGatewayUrl,
            accessToken,
            method: "GET",
            path: "/catalog",
          });
          return normalizeMossPayCatalogPayload(json, paymentMethodsForRealm(credential.realm));
        });
      // Authenticated catalogs include the owner's independent media wallet.
      // Retain public membership discovery when account restore is unavailable.
      return regionalGatewayCatalog().pipe(
        Effect.catch((error) =>
          error.code === "not_configured" && error.realm === "memfire-phone"
            ? Effect.fail(error)
            : publicCatalog().pipe(Effect.catch(() => Effect.fail(error))),
        ),
      );
    };

    const getQuota = (): Effect.Effect<MossPayQuota, MossPayError> =>
      withGateway(async ({ credential }) => {
        const [authorityQuota, relayQuota] = await Promise.all([
          fetchAuthorityAccountQuota(credential),
          fetchRealtimeQuota(credential),
        ]);
        return normalizeMossPayQuota(authorityQuota.account, relayQuota ?? authorityQuota.realtime);
      });

    const createOrder = (
      input: MossPayCreateOrderInput,
    ): Effect.Effect<MossPayOrder, MossPayError> =>
      withGateway(async ({ modelGatewayUrl, accessToken, credential }) => {
        const json = await mossPayFetch({
          realm: credential.realm,
          modelGatewayUrl,
          accessToken,
          method: "POST",
          path: "/orders",
          body: {
            order_type: input.orderType,
            item_code: input.itemCode,
            ...(input.idempotencyKey === undefined
              ? {}
              : { idempotency_key: input.idempotencyKey }),
          },
        });
        return parseMossPayOrder(json, input, credential.realm);
      });

    const getOrder = (input: MossPayGetOrderInput): Effect.Effect<MossPayOrder, MossPayError> =>
      withGateway(async ({ modelGatewayUrl, accessToken, credential }) => {
        const json = await mossPayFetch({
          realm: credential.realm,
          modelGatewayUrl,
          accessToken,
          method: "GET",
          path: `/orders/${encodeURIComponent(input.outTradeNo)}`,
        });
        return parseMossPayOrder(
          json,
          { orderType: "points", itemCode: "", outTradeNo: input.outTradeNo },
          credential.realm,
        );
      });

    return { getCatalog, getQuota, createOrder, getOrder };
  }),
);
