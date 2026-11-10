// FILE: publicJson.ts
// Purpose: One bounded JSON GET from a fixed public web API, sent through Moss's
//   allowlisted outbound authority with the user's HTTP(S) proxy setting.
// Layer: Server utility
// Exports: requestPublicJson, PublicJsonHttpError, and their types
//
// GET only: nothing Moss sends this way carries a request body, so there is no
// body (and no body size) to bound here.

import {
  decodeOutboundJson,
  outboundHttp,
  resolveOutboundProxyUrl,
} from "@moss/shared/outboundHttp";

export interface PublicJsonPolicy {
  /** Names the caller in outbound-authority errors and logs. */
  readonly service: string;
  /** Exact origins the request and any redirect may reach. */
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxRedirects?: number;
}

export interface PublicJsonRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The service answered, but not with a 2xx: it is reachable and refused the request. */
export class PublicJsonHttpError extends Error {
  readonly status: number;

  constructor(service: string, status: number) {
    super(`${service} answered HTTP ${status}.`);
    this.name = "PublicJsonHttpError";
    this.status = status;
  }
}

/**
 * Resolves the parsed body of a 2xx answer. Rejects with PublicJsonHttpError on
 * any other status, and with another error on bad JSON, a timeout, or no network.
 */
export type RequestPublicJson = (
  policy: PublicJsonPolicy,
  request: PublicJsonRequest,
) => Promise<unknown>;

export const requestPublicJson: RequestPublicJson = async (policy, request) => {
  const proxyUrl = resolveOutboundProxyUrl(request.url, process.env);
  const response = await outboundHttp.request({
    policy: {
      service: policy.service,
      allowedOrigins: policy.allowedOrigins,
      timeoutMs: policy.timeoutMs,
      maxRequestBytes: 0,
      maxResponseBytes: 1024 * 1024,
      maxRedirects: policy.maxRedirects ?? 0,
      maxConcurrent: 4,
      maxQueued: 16,
      requirePublicAddress: true,
      // Fake-ip DNS proxies resolve public hosts into the RFC 2544 benchmark range.
      allowBenchmarkAddressRange: true,
      ...(proxyUrl ? { proxyUrl } : {}),
    },
    url: request.url,
    method: "GET",
    ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new PublicJsonHttpError(policy.service, response.status);
  }
  return decodeOutboundJson(response, { maxDepth: 32, maxNodes: 100_000 });
};
