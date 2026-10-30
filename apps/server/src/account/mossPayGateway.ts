import { Data } from "effect";
import type { MossManagedGatewayAuthority } from "../provider/mossManagedGatewayTrust";

// Moss 会员/积分支付的网关客户端。moss server 不直接碰微信支付或 Stripe，
// 而是把请求转发到该账号区域的 /moss-pay/* 路由，用 gateway access token 鉴权。
// 国内手机号走广州源站 WeChat Native；Google 走全球 Stripe Checkout。
// 档位/积分包数字由该账号 authority 所属数据库配置。

export type MossPayErrorCode =
  | "not_configured"
  | "unauthorized"
  | "gateway_unavailable"
  | "gateway_error"
  | "checkout_retry_expired"
  | "invalid_response";

export class MossPayError extends Data.TaggedError("MossPayError")<{
  readonly code: MossPayErrorCode;
  readonly message: string;
  readonly realm?: MossManagedGatewayAuthority;
  readonly cause?: unknown;
}> {}

export interface MossPayGatewayOrder {
  readonly outTradeNo: string;
  readonly codeUrl?: string;
}

const MOSS_MEMFIRE_PHONE_PAY_BASE_URL_ENV_KEY = "MOSS_MEMFIRE_PHONE_PAY_BASE_URL";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function cnPhonePayOverride(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const candidate = env[MOSS_MEMFIRE_PHONE_PAY_BASE_URL_ENV_KEY]?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const loopbackHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (
      (url.protocol !== "https:" && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return trimTrailingSlash(url.toString());
  } catch {
    return undefined;
  }
}

/**
 * Route using the validated credential realm, never a model hostname heuristic.
 * Phone payments require their own explicit endpoint. A model gateway migration
 * cannot silently move the WeChat endpoint or capture Google account tokens.
 */
export function resolveMossPayBaseUrl(
  input: { readonly realm: MossManagedGatewayAuthority; readonly modelGatewayUrl: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (input.realm === "memfire-phone") {
    const override = cnPhonePayOverride(env);
    if (override) return override;
    throw new MossPayError({
      code: "not_configured",
      realm: "memfire-phone",
      message: "微信支付暂不可用，请稍后重试。",
    });
  }
  if (input.realm !== "supabase-google") {
    throw new MossPayError({
      code: "not_configured",
      message: "A verified payment account realm is required.",
    });
  }
  // modelGatewayUrl 形如 https://host/functions/v1/moss-model-gateway/v1
  // moss-pay 路由形如  https://host/functions/v1/moss-pay/...
  const url = new URL(input.modelGatewayUrl);
  const path = url.pathname.replace(/\/moss-model-gateway\/?.*$/, "");
  url.pathname = `${path}/moss-pay`;
  url.search = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

async function parseJson(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text();
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function mossPayFetch(input: {
  readonly realm: MossManagedGatewayAuthority;
  readonly modelGatewayUrl: string;
  readonly accessToken: string | null;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const base = resolveMossPayBaseUrl(input);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.accessToken) headers.Authorization = `Bearer ${input.accessToken}`;
  if (input.body) headers["Content-Type"] = "application/json";
  let resp: Response;
  try {
    resp = await fetch(`${base}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (cause) {
    throw new MossPayError({
      code: "gateway_unavailable",
      message: "The Moss payment service is unreachable right now.",
      cause,
    });
  }
  const json = await parseJson(resp);
  if (resp.status === 401 || resp.status === 403) {
    throw new MossPayError({
      code: "unauthorized",
      message: "A valid Moss account session is required to use payments.",
    });
  }
  if (!resp.ok) {
    if (resp.status === 409 && json.error === "media_checkout_retry_expired") {
      throw new MossPayError({
        code: "checkout_retry_expired",
        message: "This checkout request expired. Close it and start a new top-up to continue.",
      });
    }
    throw new MossPayError({
      code: "gateway_error",
      message:
        typeof json.error === "string"
          ? `Payment service error: ${json.error}`
          : `Payment service returned ${resp.status}.`,
    });
  }
  return json;
}
