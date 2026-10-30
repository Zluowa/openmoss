// FILE: mossMarketplaceAggregationSources.ts
// Purpose: Read-only adapters for remote plugin, skill, and MCP catalogs.
// Safety: adapters fetch metadata only. They never clone, install, spawn, or
//          return executable command lines.
// Configuration: MOSS_MARKETPLACE_SOURCES and MOSS_MARKETPLACE_DISABLED_SOURCES
// are comma-separated source ids; MOSS_MARKETPLACE_ENABLE_DISCOVERY=1 opts into
// the discovery-only awesome-mcp-servers adapter. Smithery also requires
// SMITHERY_API_KEY.

import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";

import type {
  ProviderCatalogActivity,
  ProviderCatalogEntry,
  ProviderCatalogLicense,
  ProviderCatalogResourceKind,
  ProviderCatalogSecurity,
  ProviderCatalogSourceTier,
  ProviderCatalogReinstatement,
  ProviderCatalogWithdrawal,
} from "@synara/contracts";

export type MossMarketplaceCandidateKind = ProviderCatalogResourceKind;

export interface MossMarketplaceCandidate {
  readonly identity: string;
  readonly kind: MossMarketplaceCandidateKind;
  readonly name: string;
  readonly displayName?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly homepageUrl?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly featured?: boolean | undefined;
  readonly verified?: boolean | undefined;
  readonly compatibility?: readonly string[] | undefined;
  readonly license?: Partial<ProviderCatalogLicense> | undefined;
  readonly activity?: Partial<ProviderCatalogActivity> | undefined;
  readonly withdrawal?: Partial<ProviderCatalogWithdrawal> | undefined;
  readonly reinstatement?: Partial<ProviderCatalogReinstatement> | undefined;
  readonly security?:
    | {
        readonly status?: ProviderCatalogSecurity["status"] | undefined;
        readonly riskLevel?: ProviderCatalogSecurity["riskLevel"] | undefined;
        readonly permissions?: readonly string[] | undefined;
        readonly permissionSource?: ProviderCatalogSecurity["permissionSource"] | undefined;
        readonly signals?: readonly string[] | undefined;
        readonly checkedAt?: string | undefined;
        readonly executionPolicy?: "never" | undefined;
      }
    | undefined;
  readonly metadata?: ProviderCatalogEntry["metadata"] | undefined;
}

export interface MossMarketplaceSourcePage {
  readonly candidates: readonly MossMarketplaceCandidate[];
  readonly nextCursor: string | null;
  readonly sourceVersion?: string | null | undefined;
  readonly generation?: number | undefined;
  readonly snapshot?: string | undefined;
  readonly revision?: MossMarketplaceGitRevision | undefined;
  readonly revisionProof?: MossMarketplaceRevisionProof | undefined;
  readonly fullSnapshot?: boolean | undefined;
  readonly complete?: boolean | undefined;
  readonly truncated?: boolean | undefined;
  readonly partial?: boolean | undefined;
}

export interface MossMarketplaceGitRevision {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
}

export type MossMarketplaceRevisionProof =
  | {
      readonly relation: "initial";
      readonly previousCommitSha: null;
    }
  | {
      readonly relation: "same";
      readonly previousCommitSha: string;
    }
  | {
      readonly relation: "direct-parent";
      readonly previousCommitSha: string;
    }
  | {
      readonly relation: "compare-ahead";
      readonly previousCommitSha: string;
      readonly aheadBy: number;
      readonly behindBy: 0;
    };

export interface MossMarketplaceSourceFetchInput {
  readonly kind: MossMarketplaceCandidateKind;
  readonly cursor: string | null;
  readonly limit: number;
  readonly query: string;
  readonly now: Date;
  readonly previousRevision?: MossMarketplaceGitRevision | undefined;
}

export type MossMarketplaceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MossMarketplaceResolvedFetchInput {
  readonly url: string;
  readonly ip: string;
  readonly init?: RequestInit | undefined;
  readonly ca?: string | undefined;
}

// The transport receives the exact address returned by the just-completed DNS
// validation. It must connect to that address while retaining URL host/SNI.
// Ordinary fetch is intentionally not this type. The runtime WeakSet below
// prevents an arbitrary function from masquerading as this capability.
export type MossMarketplaceResolvedTransport = (
  input: MossMarketplaceResolvedFetchInput,
) => Promise<Response>;

export type MossMarketplaceResolvedFetch = MossMarketplaceResolvedTransport & {
  readonly __mossMarketplaceResolvedFetchBrand: "moss-marketplace-safe";
};

export interface MossMarketplacePinnedRequestOptions {
  readonly hostname: string;
  readonly port: 443;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly servername: string;
  readonly ca?: string | undefined;
  readonly rejectUnauthorized: true;
  readonly lookup: LookupFunction;
}

export type MossMarketplacePinnedRequestAdapter = (
  options: MossMarketplacePinnedRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

const brandedResolvedFetches = new WeakSet<Function>();

export function createMossMarketplaceResolvedFetch(
  transport: MossMarketplaceResolvedTransport,
): MossMarketplaceResolvedFetch {
  brandedResolvedFetches.add(transport);
  return transport as MossMarketplaceResolvedFetch;
}

function isBrandedResolvedFetch(
  value: MossMarketplaceResolvedTransport | undefined,
): value is MossMarketplaceResolvedFetch {
  return typeof value === "function" && brandedResolvedFetches.has(value);
}

export interface MossMarketplaceSourceAdapter {
  readonly id: string;
  readonly label: string;
  readonly tier: ProviderCatalogSourceTier;
  readonly supportedKinds: readonly MossMarketplaceCandidateKind[];
  readonly enabled: boolean;
  readonly disabledReason?: string | undefined;
  readonly fetchPage: (
    input: MossMarketplaceSourceFetchInput,
  ) => Promise<MossMarketplaceSourcePage>;
}

export interface MossMarketplaceSourceOptions {
  readonly fetch?: MossMarketplaceFetch | undefined;
  readonly fetchResolved?: MossMarketplaceResolvedFetch | undefined;
  readonly now?: (() => Date) | undefined;
  readonly smitheryApiKey?: string | undefined;
  readonly enabledSourceIds?: readonly string[] | undefined;
  readonly disabledSourceIds?: readonly string[] | undefined;
  readonly enableDiscoverySources?: boolean | undefined;
  readonly allowedRemoteHosts?: readonly string[] | undefined;
  readonly resolveHost?: ((hostname: string) => Promise<readonly string[]>) | undefined;
  readonly remoteTimeoutMs?: number | undefined;
  readonly maxRedirects?: number | undefined;
  readonly tlsCa?: string | undefined;
}

export const MOSS_MARKETPLACE_SOURCE_IDS = {
  officialMcpRegistry: "official-mcp-registry",
  anthropicPlugins: "anthropic-plugins-official",
  openaiSkills: "openai-skills",
  smithery: "smithery",
  awesomeMcp: "awesome-mcp-servers",
} as const;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECT_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 8_192;
const MAX_REDIRECT_CHUNKS = 2_048;
const CLEANUP_HOOK_TIMEOUT_MS = 50;
const MAX_DNS_IN_FLIGHT = 32;
const REMOTE_REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const GITHUB_API_URL = "https://api.github.com";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const DEFAULT_ALLOWED_REMOTE_HOSTS = [
  "registry.modelcontextprotocol.io",
  "raw.githubusercontent.com",
  "api.github.com",
  "api.smithery.ai",
  "github.com",
  "www.github.com",
] as const;

export const MOSS_MARKETPLACE_DEFAULT_REMOTE_HOSTS = DEFAULT_ALLOWED_REMOTE_HOSTS;

export type MossMarketplaceRemoteErrorCode =
  | "REMOTE_ENDPOINT_NOT_ALLOWED"
  | "REMOTE_SCHEME_NOT_ALLOWED"
  | "REMOTE_REDIRECT_HOST_NOT_ALLOWED"
  | "REMOTE_REDIRECT_SCHEME_NOT_ALLOWED"
  | "REMOTE_REDIRECT_LIMIT"
  | "REMOTE_DNS_RESOLUTION_FAILED"
  | "REMOTE_HOST_IP_NOT_ALLOWED"
  | "REMOTE_TIMEOUT"
  | "REMOTE_RESPONSE_TOO_LARGE"
  | "REMOTE_RESPONSE_TOO_MANY_CHUNKS"
  | "REMOTE_UPSTREAM_REVISION_UNAVAILABLE"
  | "REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN"
  | "REMOTE_UPSTREAM_SCHEMA_INVALID"
  | "REMOTE_BODY_UNAVAILABLE"
  | "REMOTE_SAFE_TRANSPORT_UNAVAILABLE"
  | "REMOTE_HTTP_STATUS"
  | "REMOTE_INVALID_JSON"
  | "REMOTE_FETCH_FAILED";

export class MossMarketplaceRemoteFetchError extends Error {
  readonly code: MossMarketplaceRemoteErrorCode;

  constructor(code: MossMarketplaceRemoteErrorCode) {
    super(code);
    this.name = "MossMarketplaceRemoteFetchError";
    this.code = code;
  }
}

interface MossReadableReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array | undefined;
}

interface MossReadableReader {
  readonly read: () => Promise<MossReadableReadResult>;
  readonly cancel?: (() => Promise<unknown> | unknown) | undefined;
  readonly releaseLock?: (() => void) | undefined;
}

interface MossReadableBody {
  readonly getReader?: (() => MossReadableReader) | undefined;
  readonly cancel?: (() => Promise<unknown> | unknown) | undefined;
  readonly abort?: (() => Promise<unknown> | unknown) | undefined;
  readonly destroy?: (() => void) | undefined;
}

interface RemoteFetchPolicy {
  readonly allowedHosts: ReadonlySet<string>;
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly fetchResolved: MossMarketplaceResolvedFetch;
  readonly tlsCa?: string | undefined;
}

type BoundMossMarketplaceFetch = MossMarketplaceFetch & {
  readonly mossPolicy: RemoteFetchPolicy;
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is RecordLike {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function ownDataValue(record: RecordLike | undefined, key: string): unknown {
  if (!record) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return undefined;
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownArrayValues(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  } catch {
    return undefined;
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return undefined;
    }
    if (!descriptor || !("value" in descriptor)) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validNonEmptyPath(value: unknown): boolean {
  return stringValue(value) !== undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: readonly (string | undefined | null)[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    ),
  ];
}

function safeUrl(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

function parseIpv4(value: string): readonly number[] | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  const parsed = octets.map((octet) => Number(octet));
  return parsed.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? parsed
    : null;
}

function parseIpv6(value: string): readonly number[] | null {
  const input = value.replace(/^\[|\]$/g, "");
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const words: number[] = [];
    for (const token of half.split(":")) {
      if (token.includes(".")) {
        const octets = parseIpv4(token);
        if (!octets) return null;
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves.length === 2 ? halves[1]! : "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeroWords = 8 - left.length - right.length;
  if (zeroWords < 1) return null;
  return [...left, ...Array.from({ length: zeroWords }, () => 0), ...right];
}

function disallowedIpv4(octets: readonly number[]): boolean {
  const first = octets[0] ?? -1;
  const second = octets[1];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second === 18) ||
    (first === 198 && second === 19) ||
    (first >= 224 && first <= 255) ||
    (first === 255 && second === 255)
  );
}

function disallowedIp(value: string): boolean {
  const ip = value.trim().toLowerCase();
  if (isIP(ip) === 4) return disallowedIpv4(parseIpv4(ip) ?? []);
  if (isIP(ip) !== 6) return true;
  const words = parseIpv6(ip);
  if (!words || words.length !== 8) return true;
  const allZero = words.every((word) => word === 0);
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  const first = words[0]!;
  return (
    allZero ||
    words.every((word, index) => word === 0 || (index === 7 && word === 1)) ||
    ipv4Mapped ||
    ipv4Compatible ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function remoteTarget(value: string, policy: RemoteFetchPolicy, redirect: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MossMarketplaceRemoteFetchError("REMOTE_ENDPOINT_NOT_ALLOWED");
  }
  if (parsed.protocol !== "https:") {
    throw new MossMarketplaceRemoteFetchError(
      redirect ? "REMOTE_REDIRECT_SCHEME_NOT_ALLOWED" : "REMOTE_SCHEME_NOT_ALLOWED",
    );
  }
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new MossMarketplaceRemoteFetchError(
      redirect ? "REMOTE_REDIRECT_HOST_NOT_ALLOWED" : "REMOTE_ENDPOINT_NOT_ALLOWED",
    );
  }
  const host = normalizedHost(parsed.hostname);
  if (
    isIP(host) !== 0 ||
    /^\d+$/.test(host) ||
    /^0x[0-9a-f]+$/i.test(host) ||
    /^\d+(?:\.\d+){1,3}$/.test(host)
  ) {
    throw new MossMarketplaceRemoteFetchError(
      redirect ? "REMOTE_REDIRECT_HOST_NOT_ALLOWED" : "REMOTE_ENDPOINT_NOT_ALLOWED",
    );
  }
  if (!policy.allowedHosts.has(host)) {
    throw new MossMarketplaceRemoteFetchError(
      redirect ? "REMOTE_REDIRECT_HOST_NOT_ALLOWED" : "REMOTE_ENDPOINT_NOT_ALLOWED",
    );
  }
  return parsed;
}

async function verifyRemoteHost(
  url: URL,
  policy: RemoteFetchPolicy,
  signal?: AbortSignal,
): Promise<string> {
  let addresses: readonly string[];
  try {
    const resolution = policy.resolveHost(url.hostname);
    addresses = signal ? await awaitWithAbort(resolution, signal) : await resolution;
  } catch {
    if (signal?.aborted) {
      throw new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT");
    }
    throw new MossMarketplaceRemoteFetchError("REMOTE_DNS_RESOLUTION_FAILED");
  }
  if (addresses.length === 0 || addresses.some(disallowedIp)) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_HOST_IP_NOT_ALLOWED");
  }
  const verified = addresses.find((address) => !disallowedIp(address));
  if (!verified) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_HOST_IP_NOT_ALLOWED");
  }
  return verified;
}

const defaultPinnedRequestAdapter: MossMarketplacePinnedRequestAdapter = (options, callback) =>
  httpsRequest(options, callback);

function pinnedHttpsFetch(
  input: MossMarketplaceResolvedFetchInput,
  requestAdapter: MossMarketplacePinnedRequestAdapter,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return Promise.reject(new MossMarketplaceRemoteFetchError("REMOTE_ENDPOINT_NOT_ALLOWED"));
  }
  if (target.protocol !== "https:" || !isIP(input.ip)) {
    return Promise.reject(new MossMarketplaceRemoteFetchError("REMOTE_SAFE_TRANSPORT_UNAVAILABLE"));
  }
  const headers = new Headers(input.init?.headers);
  const hostHeader = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  headers.set("host", hostHeader);
  const body = input.init?.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== "string" &&
    !(body instanceof Uint8Array)
  ) {
    return Promise.reject(new MossMarketplaceRemoteFetchError("REMOTE_SAFE_TRANSPORT_UNAVAILABLE"));
  }
  return new Promise<Response>((resolve, reject) => {
    const requestOptions: MossMarketplacePinnedRequestOptions = {
      hostname: input.ip,
      port: 443,
      path: `${target.pathname}${target.search}`,
      method: input.init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      servername: target.hostname,
      ca: input.ca,
      rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => {
        callback(null, input.ip, isIP(input.ip));
      },
    };
    let responseDelivered = false;
    let requestPromiseSettled = false;
    let cleaned = false;
    const signal = input.init?.signal ?? undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (!responseDelivered && !requestPromiseSettled) {
        requestPromiseSettled = true;
        cleanup();
        reject(new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT"));
      } else {
        cleanup();
      }
      request.destroy(new Error("aborted"));
    };
    const request = requestAdapter(requestOptions, (response) => {
      if (requestPromiseSettled) return;
      responseDelivered = true;
      requestPromiseSettled = true;
      const responseBody =
        typeof Readable.toWeb === "function"
          ? (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>)
          : undefined;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === "string") responseHeaders.set(name, value);
        else if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
      }
      const responseInit: ResponseInit = {
        status: response.statusCode ?? 0,
        headers: responseHeaders,
        ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
      };
      resolve(new Response(responseBody, responseInit));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => {
      if (requestPromiseSettled) return;
      requestPromiseSettled = true;
      cleanup();
      reject(error);
    });
    request.once("close", () => {
      cleanup();
      if (!requestPromiseSettled) {
        requestPromiseSettled = true;
        reject(new Error("request closed before response"));
      }
    });
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

export function createMossMarketplacePinnedHttpsFetch(
  requestAdapter: MossMarketplacePinnedRequestAdapter = defaultPinnedRequestAdapter,
): MossMarketplaceResolvedFetch {
  return createMossMarketplaceResolvedFetch((input) => pinnedHttpsFetch(input, requestAdapter));
}

function createBoundedFetch(policy: RemoteFetchPolicy): BoundMossMarketplaceFetch {
  let dnsInFlight = 0;
  const resolveHost = async (hostname: string): Promise<readonly string[]> => {
    if (dnsInFlight >= MAX_DNS_IN_FLIGHT) {
      throw new MossMarketplaceRemoteFetchError("REMOTE_DNS_RESOLUTION_FAILED");
    }
    dnsInFlight += 1;
    try {
      return await policy.resolveHost(hostname);
    } finally {
      dnsInFlight = Math.max(0, dnsInFlight - 1);
    }
  };
  const boundedPolicy = { ...policy, resolveHost } satisfies RemoteFetchPolicy;
  const bounded = (async (input: string, init?: RequestInit): Promise<Response> => {
    const target = remoteTarget(input, boundedPolicy, false);
    const verifiedIp = await verifyRemoteHost(target, boundedPolicy, init?.signal ?? undefined);
    try {
      return await boundedPolicy.fetchResolved({
        url: input,
        ip: verifiedIp,
        ca: boundedPolicy.tlsCa,
        init: { ...init, redirect: "manual" },
      });
    } catch (error) {
      if (error instanceof MossMarketplaceRemoteFetchError) throw error;
      throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
    }
  }) as BoundMossMarketplaceFetch;
  Object.defineProperty(bounded, "mossPolicy", { value: boundedPolicy });
  return bounded;
}

function canonicalUrl(value: string | undefined): string | undefined {
  const url = safeUrl(value);
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function githubSlug(value: string | undefined): string | undefined {
  const url = canonicalUrl(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return undefined;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return `${parts[0]!}/${parts[1]!.replace(/\.git$/, "")}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function githubUrl(slug: string, path = ""): string {
  const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
  return `https://github.com/${slug}${suffix}`;
}

function mcpIdentity(name: string, sourceUrl: string | undefined): string {
  const githubRepository =
    githubSlug(sourceUrl) ??
    (name.startsWith("io.github.") ? name.slice("io.github.".length) : undefined);
  return githubRepository
    ? `mcp:github:${githubRepository.toLowerCase()}`
    : `mcp:${name.toLowerCase()}`;
}

function hasAnthropicPluginSource(value: unknown): boolean {
  if (typeof value === "string") return stringValue(value) !== undefined;
  if (!isRecord(value)) return false;
  return Boolean(stringValue(value.path ?? value.url ?? value.source));
}

function dateOrUndefined(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate || !ISO_DATE.test(candidate)) return undefined;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

interface UpstreamGitRevision {
  readonly revision: MossMarketplaceGitRevision;
  readonly sourceVersion: string;
  readonly snapshot: string;
  readonly proof: MossMarketplaceRevisionProof;
}

function validGitSha(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{40}$/i.test(value);
}

function upstreamGitRevision(value: unknown): Omit<UpstreamGitRevision, "proof"> {
  const record = isPlainRecord(value) ? value : undefined;
  const commitSha = stringValue(ownDataValue(record, "sha"));
  const commitValue = ownDataValue(record, "commit");
  const commit = isPlainRecord(commitValue) ? commitValue : undefined;
  const treeValue = ownDataValue(commit, "tree");
  const commitTree = isPlainRecord(treeValue) ? treeValue : undefined;
  const treeSha = stringValue(ownDataValue(commitTree, "sha"));
  const parents = ownArrayValues(ownDataValue(record, "parents"))?.map((parent) =>
    isPlainRecord(parent) ? stringValue(ownDataValue(parent, "sha")) : undefined,
  );
  const validParents = parents?.filter((parent): parent is string => parent !== undefined);
  if (
    !validGitSha(commitSha) ||
    !validGitSha(treeSha) ||
    !parents ||
    !validParents ||
    validParents.length !== parents.length ||
    validParents.some((parent) => !validGitSha(parent))
  ) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_UNAVAILABLE");
  }
  return {
    revision: { commitSha, treeSha, parents: validParents },
    sourceVersion: commitSha,
    snapshot: `git-commit:${commitSha}:git-tree:${treeSha}`,
  };
}

export function parseMossMarketplaceGitRevisionPayload(value: unknown): MossMarketplaceGitRevision {
  return upstreamGitRevision(value).revision;
}

async function fetchUpstreamGitRevision(
  fetcher: MossMarketplaceFetch,
  revisionPayload: unknown,
  compareUrl: string,
  previousRevision: MossMarketplaceGitRevision | undefined,
): Promise<UpstreamGitRevision> {
  const current = upstreamGitRevision(revisionPayload);
  if (!previousRevision) {
    return {
      ...current,
      proof: { relation: "initial", previousCommitSha: null },
    };
  }
  if (
    !validGitSha(previousRevision.commitSha) ||
    !validGitSha(previousRevision.treeSha) ||
    previousRevision.parents.some((parent) => !validGitSha(parent))
  ) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
  }
  if (current.revision.commitSha === previousRevision.commitSha) {
    if (current.revision.treeSha !== previousRevision.treeSha) {
      throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
    }
    return {
      ...current,
      proof: { relation: "same", previousCommitSha: previousRevision.commitSha },
    };
  }
  if (current.revision.parents.includes(previousRevision.commitSha)) {
    return {
      ...current,
      proof: { relation: "direct-parent", previousCommitSha: previousRevision.commitSha },
    };
  }
  const comparison = await readJson(
    fetcher,
    `${compareUrl}/${previousRevision.commitSha}...${current.revision.commitSha}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const record = isRecord(comparison) ? comparison : undefined;
  const baseCommit = isRecord(record?.base_commit)
    ? stringValue(record.base_commit.sha)
    : undefined;
  const headCommit = isRecord(record?.head_commit)
    ? stringValue(record.head_commit.sha)
    : undefined;
  const status = stringValue(record?.status);
  const aheadBy = numberValue(record?.ahead_by);
  const behindBy = numberValue(record?.behind_by);
  if (
    status !== "ahead" ||
    baseCommit !== previousRevision.commitSha ||
    headCommit !== current.revision.commitSha ||
    aheadBy === undefined ||
    !Number.isInteger(aheadBy) ||
    aheadBy < 1 ||
    behindBy !== 0
  ) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
  }
  return {
    ...current,
    proof: {
      relation: "compare-ahead",
      previousCommitSha: previousRevision.commitSha,
      aheadBy,
      behindBy: 0,
    },
  };
}

function knownLicense(value: unknown): Partial<ProviderCatalogLicense> | undefined {
  if (value === null) return { status: "missing", spdxId: null, url: null };
  if (isRecord(value)) {
    const spdxId = stringValue(value.spdxId ?? value.spdx_id ?? value.id);
    const url = safeUrl(value.url ?? value.html_url);
    if (spdxId && isValidSpdxIdentifier(spdxId)) {
      return { status: "known", spdxId, url: url ?? null };
    }
  }
  const text = stringValue(value);
  return text && isValidSpdxIdentifier(text)
    ? { status: "known", spdxId: text, url: null }
    : text
      ? { status: "unknown", spdxId: null, url: null }
      : undefined;
}

const KNOWN_SPDX_IDENTIFIERS = new Set([
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "EPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);

export function isValidSpdxIdentifier(value: string): boolean {
  return KNOWN_SPDX_IDENTIFIERS.has(value.trim());
}

export function isMossMarketplaceAllowedArtifactUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (!parsed.port || parsed.port === "443") &&
      DEFAULT_ALLOWED_REMOTE_HOSTS.includes(
        normalizedHost(parsed.hostname) as (typeof DEFAULT_ALLOWED_REMOTE_HOSTS)[number],
      )
    );
  } catch {
    return false;
  }
}

function responseHeader(response: Response, name: string): string | null {
  return response.headers?.get(name) ?? null;
}

async function forceCloseResponseBody(
  body: unknown,
  options: { readonly skipCancel?: boolean } = {},
): Promise<void> {
  if (!body || typeof body !== "object") return;
  const closable = body as {
    cancel?: (() => Promise<unknown> | unknown) | undefined;
    abort?: (() => Promise<unknown> | unknown) | undefined;
    destroy?: (() => void) | undefined;
  };
  if (!options.skipCancel && typeof closable.cancel === "function") {
    if (await runBoundedCleanupHook(() => closable.cancel?.())) return;
  }
  if (typeof closable.abort === "function") {
    if (await runBoundedCleanupHook(() => closable.abort?.())) return;
  }
  if (typeof closable.destroy === "function") {
    await runBoundedCleanupHook(() => closable.destroy?.());
  }
}

function runBoundedCleanupHook(hook: () => unknown): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(completed);
    };
    const operation = Promise.resolve().then(hook);
    operation.then(
      () => finish(true),
      () => finish(false),
    );
    timer = setTimeout(() => finish(false), CLEANUP_HOOK_TIMEOUT_MS);
  });
}

async function cancelReader(reader: MossReadableReader): Promise<boolean> {
  const cancel = reader.cancel;
  if (!cancel) return true;
  return !(await runBoundedCleanupHook(() => cancel.call(reader)));
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createAbortAwareReader(
  reader: MossReadableReader,
  signal: AbortSignal,
): {
  readonly read: () => Promise<MossReadableReadResult>;
  readonly dispose: () => void;
} {
  type PendingRead = { readonly reject: (reason?: unknown) => void };
  let pending: PendingRead | undefined;
  const onAbort = () => {
    const current = pending;
    pending = undefined;
    current?.reject(new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    read: () => {
      if (signal.aborted) {
        return Promise.reject(new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT"));
      }
      return new Promise<MossReadableReadResult>((resolve, reject) => {
        const current: PendingRead = { reject };
        pending = current;
        reader.read().then(
          (result) => {
            if (pending === current) pending = undefined;
            resolve(result);
          },
          (error: unknown) => {
            if (pending === current) pending = undefined;
            reject(error);
          },
        );
      });
    },
    dispose: () => {
      pending = undefined;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function linkAbortSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  const onAbort = () => child.abort();
  if (parent.aborted) {
    child.abort();
    return () => undefined;
  }
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body as unknown as MossReadableBody | null;
  if (!body) return;
  let reader: MossReadableReader | undefined;
  try {
    reader = body.getReader?.();
  } catch {
    await forceCloseResponseBody(body);
    return;
  }
  if (!reader) {
    await forceCloseResponseBody(body);
    return;
  }
  const cancelFailed = await cancelReader(reader);
  try {
    reader.releaseLock?.();
  } catch {
    // Releasing an already-released reader is harmless for this cleanup path.
  }
  if (cancelFailed) await forceCloseResponseBody(body, { skipCancel: true });
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = Number.parseInt(responseHeader(response, "content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new MossMarketplaceRemoteFetchError("REMOTE_RESPONSE_TOO_LARGE");
  }
  const body = response.body as unknown as MossReadableBody | null;
  if (body === null) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_BODY_UNAVAILABLE");
  }
  if (!body || typeof body.getReader !== "function") {
    await forceCloseResponseBody(body);
    throw new MossMarketplaceRemoteFetchError("REMOTE_BODY_UNAVAILABLE");
  }
  let reader: MossReadableReader;
  try {
    reader = body.getReader();
  } catch {
    await forceCloseResponseBody(body);
    throw new MossMarketplaceRemoteFetchError("REMOTE_BODY_UNAVAILABLE");
  }
  if (!reader || typeof reader.read !== "function") {
    await forceCloseResponseBody(body);
    throw new MossMarketplaceRemoteFetchError("REMOTE_BODY_UNAVAILABLE");
  }
  {
    const abortAwareReader = createAbortAwareReader(reader, signal);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let chunkCount = 0;
    try {
      while (true) {
        const result = await abortAwareReader.read();
        if (result.done) break;
        const chunk = result.value ?? new Uint8Array();
        chunkCount += 1;
        if (chunkCount > MAX_RESPONSE_CHUNKS) {
          throw new MossMarketplaceRemoteFetchError("REMOTE_RESPONSE_TOO_MANY_CHUNKS");
        }
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw new MossMarketplaceRemoteFetchError("REMOTE_RESPONSE_TOO_LARGE");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof MossMarketplaceRemoteFetchError) throw error;
      if (signal.aborted) throw new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT");
      throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
    } finally {
      abortAwareReader.dispose();
      const cancelFailed = await cancelReader(reader);
      try {
        reader.releaseLock?.();
      } catch {
        // Releasing an already-released reader is harmless for this cleanup path.
      }
      if (cancelFailed) await forceCloseResponseBody(body, { skipCancel: true });
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
}

async function discardRedirectBody(response: Response, signal: AbortSignal): Promise<void> {
  const body = response.body as unknown as MossReadableBody | null;
  if (!body) return;
  let reader: MossReadableReader | undefined;
  try {
    reader = body.getReader?.();
  } catch {
    await forceCloseResponseBody(body);
    throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
  }
  if (!reader) {
    await forceCloseResponseBody(body);
    return;
  }
  const abortAwareReader = createAbortAwareReader(reader, signal);
  let total = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const result = await abortAwareReader.read();
      if (result.done) break;
      const chunk = result.value ?? new Uint8Array();
      chunkCount += 1;
      if (chunkCount > MAX_REDIRECT_CHUNKS) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_RESPONSE_TOO_MANY_CHUNKS");
      }
      total += chunk.byteLength;
      if (total > MAX_REDIRECT_BODY_BYTES) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_RESPONSE_TOO_LARGE");
      }
    }
  } catch (error) {
    if (error instanceof MossMarketplaceRemoteFetchError) throw error;
    if (signal.aborted) {
      throw new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT");
    }
    throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
  } finally {
    abortAwareReader.dispose();
    const cancelFailed = await cancelReader(reader);
    try {
      reader.releaseLock?.();
    } catch {
      // Releasing an already-released reader is harmless for this cleanup path.
    }
    if (cancelFailed) await forceCloseResponseBody(body, { skipCancel: true });
  }
}

async function fetchRemoteText(
  fetcher: MossMarketplaceFetch,
  url: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly text: string }> {
  const policy =
    (fetcher as Partial<BoundMossMarketplaceFetch>).mossPolicy ??
    ({
      allowedHosts: new Set(DEFAULT_ALLOWED_REMOTE_HOSTS),
      resolveHost: defaultResolveHost,
      timeoutMs: REMOTE_REQUEST_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      fetchResolved: createMossMarketplacePinnedHttpsFetch(),
    } satisfies RemoteFetchPolicy);
  const controller = new AbortController();
  const unlinkParentAbort = linkAbortSignal(init?.signal ?? undefined, controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.timeoutMs);
  try {
    let currentUrl = url;
    let requestInit = init;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const target = remoteTarget(currentUrl, policy, redirectCount > 0);
      let response: Response;
      try {
        response = await fetcher(currentUrl, {
          ...requestInit,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof MossMarketplaceRemoteFetchError) throw error;
        if (timedOut || controller.signal.aborted) {
          throw new MossMarketplaceRemoteFetchError("REMOTE_TIMEOUT");
        }
        throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
      }
      if (response.status < 300 || response.status >= 400) {
        return {
          response,
          text: await readResponseBody(response, controller.signal),
        };
      }
      await discardRedirectBody(response, controller.signal);
      if (redirectCount >= policy.maxRedirects) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_REDIRECT_LIMIT");
      }
      const location = responseHeader(response, "location");
      if (!location) throw new MossMarketplaceRemoteFetchError("REMOTE_FETCH_FAILED");
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, target);
      } catch {
        throw new MossMarketplaceRemoteFetchError("REMOTE_REDIRECT_HOST_NOT_ALLOWED");
      }
      remoteTarget(nextUrl.toString(), policy, true);
      requestInit = redirectRequestInit(requestInit, target.toString(), nextUrl.toString());
      currentUrl = nextUrl.toString();
    }
  } finally {
    clearTimeout(timeout);
    unlinkParentAbort();
  }
}

function sameRemoteOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.protocol === b.protocol &&
      normalizedHost(a.hostname) === normalizedHost(b.hostname) &&
      (a.port || "443") === (b.port || "443")
    );
  } catch {
    return false;
  }
}

function redirectRequestInit(
  init: RequestInit | undefined,
  previousUrl: string,
  nextUrl: string,
): RequestInit {
  if (sameRemoteOrigin(previousUrl, nextUrl)) return { ...init };
  const safeHeaders = new Headers();
  const original = new Headers(init?.headers);
  for (const name of ["accept", "content-type", "user-agent"]) {
    const value = original.get(name);
    if (value) safeHeaders.set(name, value);
  }
  return { ...init, headers: safeHeaders, body: undefined };
}

async function readJson(
  fetcher: MossMarketplaceFetch,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const { response, text } = await fetchRemoteText(fetcher, url, init);
  if (!response.ok) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_HTTP_STATUS");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    void error;
    throw new MossMarketplaceRemoteFetchError("REMOTE_INVALID_JSON");
  }
}

async function readText(
  fetcher: MossMarketplaceFetch,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const { response, text } = await fetchRemoteText(fetcher, url, init);
  if (!response.ok) {
    throw new MossMarketplaceRemoteFetchError("REMOTE_HTTP_STATUS");
  }
  return text;
}

function sourceSecurity(input: {
  readonly status: ProviderCatalogSecurity["status"];
  readonly riskLevel?: ProviderCatalogSecurity["riskLevel"] | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly permissionSource?: ProviderCatalogSecurity["permissionSource"] | undefined;
  readonly signals: readonly string[];
}): NonNullable<MossMarketplaceCandidate["security"]> {
  return {
    status: input.status,
    riskLevel: input.riskLevel ?? "unknown",
    permissions: uniqueStrings(input.permissions?.length ? input.permissions : ["unknown"]),
    permissionSource: input.permissionSource ?? "unknown",
    signals: uniqueStrings([...input.signals, "execution-disabled"]),
    executionPolicy: "never",
  };
}

function activityFromDate(input: {
  readonly lastUpdatedAt?: string | undefined;
  readonly now: Date;
  readonly archived?: boolean | undefined;
  readonly status?: string | undefined;
}): Partial<ProviderCatalogActivity> {
  const lastUpdatedAt = dateOrUndefined(input.lastUpdatedAt);
  if (input.archived) return { status: "archived", lastUpdatedAt: lastUpdatedAt ?? null };
  if (input.status === "deprecated") {
    return { status: "stale", lastUpdatedAt: lastUpdatedAt ?? null };
  }
  if (!lastUpdatedAt) return { status: "unknown", lastUpdatedAt: null };
  const ageMs = input.now.valueOf() - new Date(lastUpdatedAt).valueOf();
  return {
    status: ageMs > 365 * 24 * 60 * 60 * 1000 ? "stale" : "active",
    lastUpdatedAt,
  };
}

const NEGATIVE_CATALOG_STATUSES = new Set<ProviderCatalogWithdrawal["status"]>([
  "deleted",
  "deprecated",
  "moderated",
  "withdrawn",
  "removed",
]);

function withdrawalFromStatus(
  status: string | undefined,
  sourceId: string,
  identity: string,
  now: Date,
  raw: RecordLike,
): Partial<ProviderCatalogWithdrawal> | undefined {
  if (!status || !NEGATIVE_CATALOG_STATUSES.has(status as ProviderCatalogWithdrawal["status"])) {
    return undefined;
  }
  const sourceVersion = stringValue(raw.version ?? raw.updatedAt ?? raw.updated_at) ?? null;
  const generation = Math.max(0, Math.floor(numberValue(raw.generation) ?? 0));
  const snapshot =
    stringValue(raw.snapshot ?? raw.snapshotId) ??
    `${sourceId}:${identity}:${status}:${sourceVersion ?? "unknown"}`;
  return {
    status: status as ProviderCatalogWithdrawal["status"],
    sourceVersion,
    observedAt: now.toISOString(),
    generation,
    snapshot,
  };
}

function reinstatementFromRaw(
  raw: RecordLike,
  sourceId: string,
  sourceTier: ProviderCatalogSourceTier,
  now: Date,
): Partial<ProviderCatalogReinstatement> | undefined {
  const value = isRecord(raw.reinstatement) ? raw.reinstatement : undefined;
  if (!value) return undefined;
  const generation = numberValue(value.generation);
  const snapshot = stringValue(value.snapshot ?? value.snapshotId);
  const reason = stringValue(value.reason);
  if (generation === undefined || snapshot === undefined || reason === undefined) {
    return undefined;
  }
  return {
    sourceId,
    sourceTier,
    sourceVersion: stringValue(value.sourceVersion ?? value.version) ?? null,
    observedAt: dateOrUndefined(value.observedAt) ?? now.toISOString(),
    generation: Math.max(0, Math.floor(generation)),
    snapshot,
    reason,
  };
}

function candidateFromMcpServer(
  raw: RecordLike,
  sourceId: string,
  now: Date,
): MossMarketplaceCandidate | null {
  const server = isRecord(raw.server) ? raw.server : raw;
  const name = stringValue(server.name);
  if (!name) return null;
  const title = stringValue(server.title);
  const description = stringValue(server.description);
  const repository = isRecord(server.repository) ? server.repository : undefined;
  const githubName = name.startsWith("io.github.")
    ? name.slice("io.github.".length).split("/")
    : [];
  const sourceUrl =
    safeUrl(repository?.url) ??
    safeUrl(server.repositoryUrl) ??
    (githubName.length >= 2 ? githubUrl(githubName[0]!, githubName[1]!) : undefined);
  const packages = arrayValue(server.packages).filter(isRecord);
  const remotes = arrayValue(server.remotes).filter(isRecord);
  const transports = uniqueStrings([
    ...packages.map((item) =>
      isRecord(item.transport) ? stringValue(item.transport.type) : undefined,
    ),
    ...remotes.map((item) => stringValue(item.type)),
  ]);
  const registries = uniqueStrings(packages.map((item) => stringValue(item.registryType)));
  const status = stringValue(server.status);
  const identity = mcpIdentity(name, sourceUrl);
  const updatedAt = dateOrUndefined(server.updatedAt ?? server.updated_at);
  const license = knownLicense(server.license ?? server.licenses);
  const permissions = uniqueStrings([
    packages.length > 0 ? "process" : undefined,
    remotes.length > 0 ? "network" : undefined,
    remotes.length > 0 ? "remote-service" : undefined,
  ]);
  return {
    identity,
    kind: "mcp",
    name,
    displayName: title ?? null,
    description: description ?? null,
    tags: uniqueStrings([
      ...arrayValue(server.tags).map(stringValue),
      ...registries.map((value) => `registry:${value}`),
      ...transports.map((value) => `transport:${value}`),
    ]),
    sourceUrl: sourceUrl ?? null,
    homepageUrl: safeUrl(server.websiteUrl ?? server.homepage) ?? sourceUrl ?? null,
    version: stringValue(server.version) ?? null,
    featured: booleanValue(server.featured) ?? false,
    verified: booleanValue(server.verified) ?? false,
    compatibility: uniqueStrings(["mcp", ...transports, ...registries]).sort(),
    license,
    activity: activityFromDate({ lastUpdatedAt: updatedAt, now, status }),
    withdrawal: withdrawalFromStatus(status, sourceId, identity, now, server),
    reinstatement: reinstatementFromRaw(server, sourceId, "official", now),
    security: sourceSecurity({
      status: "needs-review",
      permissions,
      permissionSource: permissions.length > 0 ? "inferred" : "unknown",
      signals: [
        "official-registry-listed",
        "official-registry-minimal-moderation",
        ...(status === "deprecated" ? ["official-registry-deprecated"] : []),
      ],
    }),
    metadata: {
      registryName: name,
      registryStatus: status ?? "active",
      packageCount: packages.length,
      remoteCount: remotes.length,
      sourceId,
    },
  };
}

function createOfficialMcpRegistrySource(
  fetcher: MossMarketplaceFetch,
): MossMarketplaceSourceAdapter {
  return {
    id: MOSS_MARKETPLACE_SOURCE_IDS.officialMcpRegistry,
    label: "Official MCP Registry",
    tier: "official",
    supportedKinds: ["mcp"],
    enabled: true,
    fetchPage: async ({ cursor, limit, now }) => {
      const params = new URLSearchParams({
        limit: String(Math.min(limit, 100)),
      });
      if (cursor) params.set("cursor", cursor);
      const payload = await readJson(
        fetcher,
        `https://registry.modelcontextprotocol.io/v0.1/servers?${params.toString()}`,
        { headers: { accept: "application/json" } },
      );
      const record = isRecord(payload) ? payload : {};
      const rawServers = arrayValue(record.servers).filter(isRecord);
      const metadata = isRecord(record.metadata) ? record.metadata : {};
      const nextCursor = stringValue(metadata.nextCursor ?? metadata.next_cursor) ?? null;
      const complete = metadata.complete === true;
      const truncated = typeof metadata.truncated === "boolean" ? metadata.truncated : undefined;
      const partial = typeof metadata.partial === "boolean" ? metadata.partial : undefined;
      return {
        candidates: rawServers
          .map((server) =>
            candidateFromMcpServer(server, MOSS_MARKETPLACE_SOURCE_IDS.officialMcpRegistry, now),
          )
          .filter((candidate): candidate is MossMarketplaceCandidate => candidate !== null),
        nextCursor,
        sourceVersion: stringValue(metadata.sourceVersion ?? metadata.version) ?? null,
        generation: numberValue(metadata.generation),
        snapshot: stringValue(metadata.snapshot ?? metadata.snapshotId),
        complete,
        truncated,
        partial,
        fullSnapshot: nextCursor === null && complete && truncated === false && partial === false,
      };
    },
  };
}

function candidateFromAnthropicPlugin(raw: RecordLike, now: Date): MossMarketplaceCandidate | null {
  const name = stringValue(raw.name);
  if (!name || !hasAnthropicPluginSource(raw.source)) return null;
  const rawSource = raw.source;
  const sourceObject = isRecord(rawSource) ? rawSource : undefined;
  const sourcePath = stringValue(
    sourceObject?.path ?? (typeof rawSource === "string" ? rawSource : undefined),
  );
  const sourceUrl =
    safeUrl(sourceObject?.url) ??
    safeUrl(sourceObject?.source) ??
    (sourcePath?.startsWith("https://") ? safeUrl(sourcePath) : undefined) ??
    (sourcePath ? githubUrl("anthropics/claude-plugins-official", sourcePath) : undefined);
  const canonicalSourceUrl = canonicalUrl(sourceUrl);
  const identity = `plugin:${canonicalSourceUrl?.toLowerCase() ?? `anthropic-plugins-official#${name.toLowerCase()}`}`;
  return {
    identity,
    kind: "plugin",
    name,
    displayName: stringValue(raw.displayName ?? raw.name) ?? null,
    description: stringValue(raw.description) ?? null,
    tags: uniqueStrings([stringValue(raw.category), ...arrayValue(raw.tags).map(stringValue)]),
    sourceUrl: canonicalSourceUrl ?? null,
    homepageUrl: safeUrl(raw.homepage ?? raw.homepageUrl) ?? canonicalSourceUrl ?? null,
    version: stringValue(raw.version) ?? null,
    featured: booleanValue(raw.featured) ?? false,
    verified: true,
    compatibility: ["claude-code", "plugin"],
    license: knownLicense(raw.license),
    activity: { status: "unknown", lastUpdatedAt: null },
    withdrawal: withdrawalFromStatus(
      stringValue(raw.status),
      MOSS_MARKETPLACE_SOURCE_IDS.anthropicPlugins,
      identity,
      now,
      raw,
    ),
    reinstatement: reinstatementFromRaw(
      raw,
      MOSS_MARKETPLACE_SOURCE_IDS.anthropicPlugins,
      "official",
      now,
    ),
    security: sourceSecurity({
      status: "source-reviewed",
      signals: [
        "anthropic-managed-marketplace",
        "source-listed-not-runtime-scanned",
        "linked-plugin-license-required",
      ],
    }),
    metadata: {
      marketplace: "anthropics/claude-plugins-official",
      sourcePath: sourcePath ?? null,
    },
  };
}

function createAnthropicPluginSource(fetcher: MossMarketplaceFetch): MossMarketplaceSourceAdapter {
  return {
    id: MOSS_MARKETPLACE_SOURCE_IDS.anthropicPlugins,
    label: "Anthropic Official Plugin Marketplace",
    tier: "official",
    supportedKinds: ["plugin"],
    enabled: true,
    fetchPage: async ({ now, previousRevision }) => {
      const revisionPayload = await readJson(
        fetcher,
        "https://api.github.com/repos/anthropics/claude-plugins-official/commits?path=.claude-plugin%2Fmarketplace.json&per_page=1",
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      const revision = await fetchUpstreamGitRevision(
        fetcher,
        arrayValue(revisionPayload).find(isRecord),
        "https://api.github.com/repos/anthropics/claude-plugins-official/compare",
        previousRevision,
      );
      const payload = await readJson(
        fetcher,
        `https://raw.githubusercontent.com/anthropics/claude-plugins-official/${revision.revision.commitSha}/.claude-plugin/marketplace.json`,
        { headers: { accept: "application/json" } },
      );
      if (!isRecord(payload) || !Array.isArray(payload.plugins)) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
      }
      if (!payload.plugins.every(isRecord)) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
      }
      const candidates: MossMarketplaceCandidate[] = [];
      for (const plugin of payload.plugins) {
        const candidate = candidateFromAnthropicPlugin(plugin, now);
        if (!candidate) {
          throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
        }
        candidates.push(candidate);
      }
      return {
        candidates,
        nextCursor: null,
        sourceVersion: revision.sourceVersion,
        snapshot: revision.snapshot,
        revision: revision.revision,
        revisionProof: revision.proof,
        complete: true,
        truncated: false,
        partial: false,
        fullSnapshot: true,
      };
    },
  };
}

function createOpenAiSkillsSource(fetcher: MossMarketplaceFetch): MossMarketplaceSourceAdapter {
  return {
    id: MOSS_MARKETPLACE_SOURCE_IDS.openaiSkills,
    label: "OpenAI Skills Catalog",
    tier: "official",
    supportedKinds: ["skill"],
    enabled: true,
    fetchPage: async ({ now, previousRevision }) => {
      const revisionPayload = await readJson(
        fetcher,
        `${GITHUB_API_URL}/repos/openai/skills/commits/main`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      const revision = await fetchUpstreamGitRevision(
        fetcher,
        revisionPayload,
        `${GITHUB_API_URL}/repos/openai/skills/compare`,
        previousRevision,
      );
      const payload = await readJson(
        fetcher,
        `${GITHUB_API_URL}/repos/openai/skills/git/trees/${revision.revision.commitSha}?recursive=1`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (
        !isRecord(payload) ||
        !Array.isArray(payload.tree) ||
        typeof payload.truncated !== "boolean"
      ) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
      }
      if (!validGitSha(stringValue(payload.sha)) || !payload.tree.every(isRecord)) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
      }
      if (payload.tree.some((entry) => !validNonEmptyPath(entry.path))) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_SCHEMA_INVALID");
      }
      if (stringValue(payload.sha) !== revision.revision.treeSha) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_UNAVAILABLE");
      }
      const truncated = payload.truncated;
      const complete = truncated === false;
      const partial = truncated === true ? true : truncated === false ? false : undefined;
      const tree = payload.tree.filter(isRecord);
      const candidates = tree
        .map((entry) => stringValue(entry.path))
        .filter((path): path is string =>
          Boolean(path?.startsWith("skills/") && path.endsWith("/SKILL.md")),
        )
        .map((entry): MossMarketplaceCandidate | null => {
          const name = entry.slice("skills/".length, -"/SKILL.md".length);
          if (!name) return null;
          const encodedPath = name
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");
          const sourceUrl = githubUrl(
            "openai/skills",
            `tree/${revision.revision.commitSha}/skills/${encodedPath}`,
          );
          return {
            identity: `skill:github:openai/skills#${name.toLowerCase()}`,
            kind: "skill" as const,
            name,
            displayName: name,
            description: null,
            tags: ["codex", "agent-skill"],
            sourceUrl,
            homepageUrl: sourceUrl,
            version: null,
            featured: false,
            verified: true,
            compatibility: ["codex", "agent-skill"],
            activity: activityFromDate({ now }),
            security: sourceSecurity({
              status: "source-reviewed",
              permissions: ["unknown"],
              signals: ["openai-maintained-catalog", "skill-license-is-directory-specific"],
            }),
            metadata: {
              repository: "openai/skills",
              path: `skills/${name}`,
              licenseCheck: "deferred-to-skill-detail",
            },
          };
        })
        .filter((candidate): candidate is MossMarketplaceCandidate => candidate !== null);
      return {
        candidates,
        nextCursor: null,
        sourceVersion: revision.sourceVersion,
        snapshot: revision.snapshot,
        revision: revision.revision,
        revisionProof: revision.proof,
        complete,
        truncated,
        partial,
        fullSnapshot:
          complete && truncated === false && partial === false && revision.snapshot.length > 0,
      };
    },
  };
}

function candidateFromSmitheryServer(raw: RecordLike, now: Date): MossMarketplaceCandidate | null {
  const name = stringValue(raw.qualifiedName ?? raw.id ?? raw.slug ?? raw.displayName);
  if (!name) return null;
  const homepageUrl = safeUrl(raw.homepage ?? raw.homepageUrl);
  const sourceUrl =
    safeUrl(raw.repositoryUrl ?? raw.repository_url ?? raw.sourceUrl) ?? homepageUrl;
  const identity = mcpIdentity(name, sourceUrl);
  const verified = booleanValue(raw.verified) ?? false;
  const updatedAt = dateOrUndefined(raw.updatedAt ?? raw.updated_at);
  const archived = booleanValue(raw.archived) ?? false;
  const status = stringValue(raw.status);
  return {
    identity,
    kind: "mcp",
    name,
    displayName: stringValue(raw.displayName ?? raw.name) ?? null,
    description: stringValue(raw.description) ?? null,
    tags: uniqueStrings([
      stringValue(raw.namespace),
      verified ? "verified-by-smithery" : undefined,
    ]),
    sourceUrl: sourceUrl ?? null,
    homepageUrl: homepageUrl ?? sourceUrl ?? null,
    version: null,
    featured: false,
    verified,
    compatibility: uniqueStrings([
      "mcp",
      booleanValue(raw.remote) ? "remote" : undefined,
      booleanValue(raw.isDeployed) ? "smithery-deployed" : undefined,
    ]),
    activity: activityFromDate({ lastUpdatedAt: updatedAt, now, archived }),
    withdrawal: withdrawalFromStatus(
      status,
      MOSS_MARKETPLACE_SOURCE_IDS.smithery,
      identity,
      now,
      raw,
    ),
    reinstatement: reinstatementFromRaw(
      raw,
      MOSS_MARKETPLACE_SOURCE_IDS.smithery,
      "aggregator",
      now,
    ),
    security: sourceSecurity({
      status: verified ? "source-reviewed" : "needs-review",
      permissions: booleanValue(raw.remote) ? ["network", "remote-service"] : ["unknown"],
      permissionSource: booleanValue(raw.remote) ? "inferred" : "unknown",
      signals: ["smithery-listed", "third-party-verification-not-local-security-proof"],
    }),
    metadata: {
      qualifiedName: name,
      namespace: stringValue(raw.namespace) ?? null,
      useCount: numberValue(raw.useCount) ?? null,
      remote: booleanValue(raw.remote) ?? null,
      deployed: booleanValue(raw.isDeployed) ?? null,
      archived,
    },
  };
}

function createSmitherySource(
  fetcher: MossMarketplaceFetch,
  apiKey: string | undefined,
): MossMarketplaceSourceAdapter {
  if (!apiKey) {
    return {
      id: MOSS_MARKETPLACE_SOURCE_IDS.smithery,
      label: "Smithery Registry",
      tier: "aggregator",
      supportedKinds: ["mcp"],
      enabled: false,
      disabledReason: "SMITHERY_API_KEY is not configured",
      fetchPage: async () => ({ candidates: [], nextCursor: null }),
    };
  }
  return {
    id: MOSS_MARKETPLACE_SOURCE_IDS.smithery,
    label: "Smithery Registry",
    tier: "aggregator",
    supportedKinds: ["mcp"],
    enabled: true,
    fetchPage: async ({ cursor, limit, query, now }) => {
      const page = Math.max(1, Number.parseInt(cursor ?? "1", 10) || 1);
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(Math.min(limit, 100)),
      });
      if (query) params.set("q", query);
      const payload = await readJson(
        fetcher,
        `https://api.smithery.ai/servers?${params.toString()}`,
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
        },
      );
      const record = isRecord(payload) ? payload : {};
      const servers = arrayValue(record.servers).filter(isRecord);
      const pagination = isRecord(record.pagination) ? record.pagination : {};
      const currentPage = numberValue(pagination.currentPage) ?? page;
      const totalPages = numberValue(pagination.totalPages) ?? currentPage;
      return {
        candidates: servers
          .map((server) => candidateFromSmitheryServer(server, now))
          .filter((candidate): candidate is MossMarketplaceCandidate => candidate !== null),
        nextCursor: currentPage < totalPages ? String(currentPage + 1) : null,
      };
    },
  };
}

function parseGithubLinks(markdown: string): readonly string[] {
  const matches = markdown.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) ?? [];
  return uniqueStrings(matches.map((value) => canonicalUrl(value))).map((value) =>
    value.replace(/\/$/, ""),
  );
}

async function githubRepositoryMetadata(
  fetcher: MossMarketplaceFetch,
  repositoryUrl: string,
  now: Date,
  signal?: AbortSignal,
): Promise<MossMarketplaceCandidate> {
  const slug = githubSlug(repositoryUrl);
  const response = slug
    ? await readJson(fetcher, `${GITHUB_API_URL}/repos/${slug}`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        ...(signal ? { signal } : {}),
      })
    : {};
  const record = isRecord(response) ? response : {};
  const license = knownLicense(record.license) ?? {
    status: "missing",
    spdxId: null,
    url: null,
  };
  const updatedAt = dateOrUndefined(record.pushed_at);
  const archived = booleanValue(record.archived) ?? false;
  const name = stringValue(record.name) ?? slug?.split("/").pop() ?? repositoryUrl;
  return {
    identity: mcpIdentity(name, canonicalUrl(stringValue(record.html_url) ?? repositoryUrl)),
    kind: "mcp",
    name,
    displayName: stringValue(record.full_name ?? name) ?? name,
    description: stringValue(record.description) ?? null,
    tags: uniqueStrings(["awesome-mcp-servers", ...arrayValue(record.topics).map(stringValue)]),
    sourceUrl: canonicalUrl(stringValue(record.html_url) ?? repositoryUrl) ?? repositoryUrl,
    homepageUrl:
      canonicalUrl(stringValue(record.homepage)) ?? canonicalUrl(repositoryUrl) ?? repositoryUrl,
    version: null,
    featured: false,
    verified: false,
    compatibility: ["mcp", "github"],
    license,
    activity: activityFromDate({ lastUpdatedAt: updatedAt, now, archived }),
    security: sourceSecurity({
      status: "needs-review",
      permissions: ["unknown"],
      signals: ["awesome-list-discovery-only", "github-metadata-reviewed", "security-scan-not-run"],
    }),
    metadata: {
      repository: slug ?? null,
      stars: numberValue(record.stargazers_count) ?? null,
      forks: numberValue(record.forks_count) ?? null,
      archived,
      licenseSource: "github-repository-api",
    },
  };
}

function createAwesomeMcpSource(
  fetcher: MossMarketplaceFetch,
  enabled: boolean,
  sourceTimeoutMs: number,
): MossMarketplaceSourceAdapter {
  return {
    id: MOSS_MARKETPLACE_SOURCE_IDS.awesomeMcp,
    label: "awesome-mcp-servers (discovery only)",
    tier: "discovery",
    supportedKinds: ["mcp"],
    enabled,
    ...(enabled ? {} : { disabledReason: "discovery sources are disabled by default" }),
    fetchPage: async ({ limit, query, now }) => {
      if (!enabled) return { candidates: [], nextCursor: null };
      const sourceController = new AbortController();
      const sourceTimeout = setTimeout(() => sourceController.abort(), sourceTimeoutMs);
      try {
        const markdown = await readText(
          fetcher,
          "https://raw.githubusercontent.com/TensorBlock/awesome-mcp-servers/main/README.md",
          { headers: { accept: "text/plain" }, signal: sourceController.signal },
        );
        const links = parseGithubLinks(markdown).slice(0, Math.min(limit, 25));
        const candidates: MossMarketplaceCandidate[] = [];
        for (const link of links) {
          if (sourceController.signal.aborted) break;
          try {
            const candidate = await githubRepositoryMetadata(
              fetcher,
              link,
              now,
              sourceController.signal,
            );
            if (
              !query ||
              `${candidate.name} ${candidate.description ?? ""}`
                .toLowerCase()
                .includes(query.toLowerCase())
            ) {
              candidates.push(candidate);
            }
          } catch {
            if (sourceController.signal.aborted) break;
            // One broken GitHub repository must not drop the rest of the source.
          }
        }
        return {
          candidates,
          nextCursor: null,
          // The capped README sample is discovery evidence, never a complete
          // authoritative snapshot or a reinstatement source.
          complete: false,
          truncated: true,
          partial: true,
          fullSnapshot: false,
        };
      } finally {
        clearTimeout(sourceTimeout);
      }
    },
  };
}

function configuredSourceIds(options: MossMarketplaceSourceOptions): {
  readonly enabled?: ReadonlySet<string> | undefined;
  readonly disabled: ReadonlySet<string>;
} {
  const enabled = options.enabledSourceIds?.length
    ? new Set(options.enabledSourceIds.map((value) => value.trim()).filter(Boolean))
    : undefined;
  return {
    enabled,
    disabled: new Set(
      (options.disabledSourceIds ?? []).map((value) => value.trim()).filter(Boolean),
    ),
  };
}

export function createMossMarketplaceSources(
  options: MossMarketplaceSourceOptions = {},
): readonly MossMarketplaceSourceAdapter[] {
  const allowedHosts = new Set(
    (options.allowedRemoteHosts?.length
      ? options.allowedRemoteHosts
      : DEFAULT_ALLOWED_REMOTE_HOSTS
    ).map(normalizedHost),
  );
  const safeTransportAvailable = Boolean(
    (!options.fetch && !options.fetchResolved) || isBrandedResolvedFetch(options.fetchResolved),
  );
  const resolvedTransport = isBrandedResolvedFetch(options.fetchResolved)
    ? options.fetchResolved
    : createMossMarketplacePinnedHttpsFetch();
  const unavailableTransport = createMossMarketplaceResolvedFetch(async (): Promise<Response> => {
    throw new MossMarketplaceRemoteFetchError("REMOTE_SAFE_TRANSPORT_UNAVAILABLE");
  });
  const fetchResolved: MossMarketplaceResolvedFetch = safeTransportAvailable
    ? resolvedTransport
    : unavailableTransport;
  const policy = {
    allowedHosts,
    resolveHost: options.resolveHost ?? defaultResolveHost,
    timeoutMs: Math.max(1, options.remoteTimeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS),
    maxRedirects: Math.max(0, Math.min(5, Math.floor(options.maxRedirects ?? MAX_REDIRECTS))),
    fetchResolved,
    tlsCa: options.tlsCa,
  } satisfies RemoteFetchPolicy;
  const fetcher = createBoundedFetch(policy);
  const configured = configuredSourceIds({
    ...options,
    enabledSourceIds:
      options.enabledSourceIds ??
      process.env.MOSS_MARKETPLACE_SOURCES?.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    disabledSourceIds:
      options.disabledSourceIds ??
      process.env.MOSS_MARKETPLACE_DISABLED_SOURCES?.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
  });
  const enableDiscoverySources =
    options.enableDiscoverySources ?? process.env.MOSS_MARKETPLACE_ENABLE_DISCOVERY === "1";
  const sources = [
    createOfficialMcpRegistrySource(fetcher),
    createAnthropicPluginSource(fetcher),
    createOpenAiSkillsSource(fetcher),
    createSmitherySource(fetcher, options.smitheryApiKey ?? process.env.SMITHERY_API_KEY),
    createAwesomeMcpSource(fetcher, enableDiscoverySources, policy.timeoutMs),
  ];
  return sources.map((source) => {
    if (!safeTransportAvailable) {
      return {
        ...source,
        enabled: false,
        disabledReason: "safe resolved-IP transport is not configured",
      };
    }
    const explicitlyEnabled = configured.enabled?.has(source.id);
    const explicitlyDisabled = configured.disabled.has(source.id);
    if (explicitlyDisabled || (configured.enabled && !explicitlyEnabled)) {
      return {
        ...source,
        enabled: false,
        disabledReason: "disabled by Moss source configuration",
      };
    }
    return source;
  });
}
