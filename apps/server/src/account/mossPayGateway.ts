import { Data } from "effect";
import type { MossManagedGatewayAuthority } from "../provider/mossManagedGatewayTrust";
import {
  isMossConnectionLevelFailure,
  mossCnPayEntries,
  type MossServiceEntryRouter,
} from "./mossServiceEntries";

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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const phonePayNotConfigured = () =>
  new MossPayError({
    code: "not_configured",
    realm: "memfire-phone",
    message: "微信支付暂不可用，请稍后重试。",
  });

/**
 * Route using the validated credential realm, never a model hostname heuristic.
 * Phone payments require their own explicit endpoint (and use only the entries
 * listed for payments, in their failover order). A model gateway migration
 * cannot silently move the WeChat endpoint or capture Google account tokens.
 */
export function resolveMossPayBaseUrl(
  input: { readonly realm: MossManagedGatewayAuthority; readonly modelGatewayUrl: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (input.realm === "memfire-phone") {
    const entries = mossCnPayEntries(env);
    if (entries) return entries.current();
    throw phonePayNotConfigured();
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
  /** The CN payment entries; tests pass their own. */
  readonly phonePayEntries?: MossServiceEntryRouter | null;
}): Promise<Record<string, unknown>> {
  const phoneEntries =
    input.realm === "memfire-phone"
      ? input.phonePayEntries === undefined
        ? mossCnPayEntries()
        : input.phonePayEntries
      : null;
  if (input.realm === "memfire-phone" && !phoneEntries) throw phonePayNotConfigured();
  const base = phoneEntries ? await phoneEntries.ensure() : resolveMossPayBaseUrl(input);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.accessToken) headers.Authorization = `Bearer ${input.accessToken}`;
  if (input.body) headers["Content-Type"] = "application/json";
  const send = (entry: string) =>
    fetch(`${entry}${input.path}`, {
      method: input.method,
      headers,
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  const unreachable = (cause: unknown) =>
    new MossPayError({
      code: "gateway_unavailable",
      message: "The Moss payment service is unreachable right now.",
      cause,
    });
  let resp: Response;
  try {
    resp = await send(base);
  } catch (cause) {
    // Below HTTP only: re-check the entries. A read moves to the next working entry at once;
    // an order is never sent twice, so it reports the outage and the next attempt uses it.
    const next =
      phoneEntries && isMossConnectionLevelFailure(cause)
        ? await phoneEntries.reportConnectionFailure(base)
        : base;
    if (input.method !== "GET" || next === base) throw unreachable(cause);
    resp = await send(next).catch((retryCause: unknown) => {
      throw unreachable(retryCause);
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
