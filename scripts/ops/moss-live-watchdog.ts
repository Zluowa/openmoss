// FILE: moss-live-watchdog.ts
// Purpose: Periodically probes Moss production endpoints (both direct NO_PROXY and proxy),
//          verifies Ed25519 update manifests on COS & R2, tracks TLS & service expiry countdowns,
//          writes atomic D:\DevTemp\moss-ops\health-status.json + watchdog.log, and posts
//          plain-Chinese alerts to the Vercel Board on green -> red transitions.

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";

import {
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";

const execFileAsync = promisify(execFile);

export const DEFAULT_OUTPUT_DIR = "D:\\DevTemp\\moss-ops";
export const DEFAULT_STATUS_PATH = join(DEFAULT_OUTPUT_DIR, "health-status.json");
export const DEFAULT_LOG_PATH = join(DEFAULT_OUTPUT_DIR, "watchdog.log");
export const DEFAULT_BOARD_CHANNEL = "moss/runtime";
export const DEFAULT_BOARD_ACTOR = "moss-ops-voice";
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export const FIXED_EXPIRIES = {
  tldraw: {
    id: "tldraw",
    name: "画布商用授权（tldraw）",
    expiresAt: "2027-02-13",
    hint: "到期前更换为正式商用授权码，避免画布弹出提示",
  },
  cvm: {
    id: "cvm",
    name: "国内主服务器到期",
    expiresAt: "2027-02-13",
    hint: "年度服务器资源，到期前提前续费即可",
  },
} as const;

export const RETIRED_HOSTS: ReadonlyArray<{ readonly host: string; readonly note: string }> = [
  {
    host: "moss-cn-realtime.inkcomicai.com",
    note: "已退役（非备案域名，已由 rt.mossbotai.com 与 moss-cn-realtime-edge.inkcomicai.com 接替）",
  },
];

export type HealthLevel = "ok" | "warn" | "bad";
export type CockpitSlotId =
  | "cn-chat"
  | "global-chat"
  | "cn-voice"
  | "global-voice"
  | "pay"
  | "share"
  | "updates";

export interface HttpProbeResult {
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly body: string;
  readonly error?: string;
}

export interface TlsCertResult {
  readonly host: string;
  readonly ok: boolean;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly level: HealthLevel;
  readonly error?: string;
}

export interface EndpointSpec {
  readonly id: string;
  readonly slot: CockpitSlotId;
  readonly name: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly expectedStatus: number;
  readonly requireDirect: boolean;
  readonly verifyBody?: (body: string) => string | null;
}

export interface ManifestSpec {
  readonly id: string;
  readonly slot: "updates";
  readonly name: string;
  readonly source: "cos" | "r2";
  readonly manifestUrl: string;
  readonly signatureUrl: string;
  readonly channelFile: string;
  readonly requireDirect: boolean;
}

export interface WatchdogCheckRecord {
  readonly id: string;
  readonly slot: CockpitSlotId;
  readonly name: string;
  readonly url: string;
  readonly status: HealthLevel;
  readonly ok: boolean;
  readonly directOk: boolean;
  readonly proxyOk: boolean | null;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly label: string;
  readonly plainDetail: string;
}

export interface CockpitServiceSummary {
  readonly id: CockpitSlotId;
  readonly name: string;
  readonly region: string;
  readonly status: HealthLevel;
  readonly label: string;
  readonly plainDetail: string;
  readonly directOk: boolean;
  readonly proxyOk: boolean | null;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
}

export interface CountdownSummary {
  readonly id: "tldraw" | "cert" | "cvm";
  readonly name: string;
  readonly expiresAt: string;
  readonly daysRemaining: number | null;
  readonly level: HealthLevel;
  readonly hint: string;
}

export interface WatchdogStatusDocument {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly checkedAt: string;
  readonly overall: HealthLevel;
  readonly summaryLabel: string;
  readonly services: ReadonlyArray<CockpitServiceSummary>;
  readonly checks: ReadonlyArray<WatchdogCheckRecord>;
  readonly countdowns: ReadonlyArray<CountdownSummary>;
  readonly tlsCerts: ReadonlyArray<TlsCertResult>;
  readonly retiredHosts: ReadonlyArray<{ readonly host: string; readonly note: string }>;
}

export interface WatchdogDependencies {
  readonly now?: () => number;
  readonly proxyUrl?: string | null;
  readonly statusPath?: string;
  readonly logPath?: string;
  readonly boardChannel?: string;
  readonly boardActor?: string;
  readonly manifestPublicKey?: string;
  readonly httpProbe?: (input: {
    readonly url: string;
    readonly method: "GET" | "POST";
    readonly proxyUrl: string | null;
    readonly timeoutMs: number;
  }) => Promise<HttpProbeResult>;
  readonly tlsProbe?: (host: string, timeoutMs: number) => Promise<TlsCertResult>;
  readonly postBoardAlert?: (input: {
    readonly channel: string;
    readonly actor: string;
    readonly message: string;
  }) => Promise<void>;
}

const SLOT_META: Readonly<
  Record<CockpitSlotId, { readonly name: string; readonly region: string }>
> = {
  "cn-chat": { name: "国内对话服务", region: "国内" },
  "global-chat": { name: "海外对话服务", region: "海外" },
  "cn-voice": { name: "国内语音对话", region: "国内" },
  "global-voice": { name: "海外语音对话", region: "海外" },
  pay: { name: "支付与充值", region: "全区" },
  share: { name: "分享与反馈", region: "全区" },
  updates: { name: "三端更新分发", region: "全区" },
};

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bmoss_sk_[A-Za-z0-9_-]{8,}\b/gu,
  /\bsb_secret_[A-Za-z0-9_-]{8,}\b/gu,
  /\bghp_[A-Za-z0-9]{8,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
];

export function redactWatchdogText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export const ENDPOINT_SPECS: ReadonlyArray<EndpointSpec> = [
  {
    id: "cn-gateway-health",
    slot: "cn-chat",
    name: "国内对话网关",
    url: "https://api.mossbotai.com/healthz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true ? null : "healthz 返回异常";
    },
  },
  {
    id: "global-gateway-health",
    slot: "global-chat",
    name: "海外对话网关",
    url: "https://evgminmhjommukstgtrj.supabase.co/functions/v1/moss-model-gateway/healthz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: false,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true ? null : "海外网关 healthz 返回异常";
    },
  },
  {
    id: "cn-realtime-ready",
    slot: "cn-voice",
    name: "国内实时语音",
    url: "https://rt.mossbotai.com/readyz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true && json?.ready === true ? null : "国内实时语音未就绪";
    },
  },
  {
    id: "cn-dictation-gate",
    slot: "cn-voice",
    name: "国内语音听写网关",
    url: "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1/audio/transcriptions",
    method: "POST",
    expectedStatus: 401,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      const err = json?.error as Record<string, unknown> | undefined;
      return err?.code === "missing_access_token" ? null : "听写鉴权响应异常";
    },
  },
  {
    id: "global-realtime-ready",
    slot: "global-voice",
    name: "海外实时语音",
    url: "https://rt-global.mossbotai.com/readyz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: false,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true && json?.ready === true ? null : "海外实时语音未就绪";
    },
  },
  {
    id: "pay-health",
    slot: "pay",
    name: "支付与充值",
    url: "https://pay.mossbotai.com/functions/v1/moss-pay/healthz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true ? null : "支付服务 healthz 异常";
    },
  },
  {
    id: "share-health",
    slot: "share",
    name: "对话分享",
    url: "https://share.mossbotai.com/healthz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return json?.ok === true ? null : "分享服务 healthz 异常";
    },
  },
  {
    id: "devs-health",
    slot: "share",
    name: "开发者报告",
    url: "https://devs.mossbotai.com/healthz",
    method: "GET",
    expectedStatus: 200,
    requireDirect: true,
    verifyBody: (body) => {
      const json = parseJsonSafe(body);
      return typeof json?.service === "string" ? null : "报告服务 healthz 异常";
    },
  },
];

export const MANIFEST_SPECS: ReadonlyArray<ManifestSpec> = [
  {
    id: "cos-desktop-latest",
    slot: "updates",
    name: "桌面端更新源 (COS)",
    source: "cos",
    manifestUrl: "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/desktop/latest.yml",
    signatureUrl:
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/desktop/latest.yml.sig",
    channelFile: "latest.yml",
    requireDirect: true,
  },
  {
    id: "r2-desktop-latest",
    slot: "updates",
    name: "桌面端更新源 (R2)",
    source: "r2",
    manifestUrl: "https://update.mossbotai.com/desktop/latest.yml",
    signatureUrl: "https://update.mossbotai.com/desktop/latest.yml.sig",
    channelFile: "latest.yml",
    requireDirect: false,
  },
  {
    id: "cos-android-latest",
    slot: "updates",
    name: "安卓端更新源 (COS)",
    source: "cos",
    manifestUrl:
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/android-latest.json",
    signatureUrl:
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/android-latest.json.sig",
    channelFile: "android-latest.json",
    requireDirect: true,
  },
  {
    id: "r2-android-latest",
    slot: "updates",
    name: "安卓端更新源 (R2)",
    source: "r2",
    manifestUrl: "https://update.mossbotai.com/mobile/android-latest.json",
    signatureUrl: "https://update.mossbotai.com/mobile/android-latest.json.sig",
    channelFile: "android-latest.json",
    requireDirect: false,
  },
];

export const TLS_HOSTS: ReadonlyArray<string> = [
  "api.mossbotai.com",
  "pay.mossbotai.com",
  "share.mossbotai.com",
  "devs.mossbotai.com",
  "rt.mossbotai.com",
  "rt-global.mossbotai.com",
  "update.mossbotai.com",
  "moss-cn-models.inkcomicai.com",
  "moss-cn-apimart-egress.inkcomicai.com",
];

export function detectConfiguredProxyUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const candidates = [
    env.MOSS_WATCHDOG_PROXY_URL,
    env.HTTPS_PROXY,
    env.HTTP_PROXY,
    env.https_proxy,
    env.http_proxy,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export async function defaultHttpProbe(input: {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly proxyUrl: string | null;
  readonly timeoutMs: number;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  const timeoutSec = Math.max(2, Math.ceil(input.timeoutMs / 1_000));
  const args = [
    "-sS",
    "-X",
    input.method,
    "-m",
    String(timeoutSec),
    ...(input.proxyUrl ? ["--proxy", input.proxyUrl] : ["--noproxy", "*"]),
    "-w",
    "\n__MOSS_HTTP_CODE__:%{http_code}",
    input.url,
  ];
  try {
    const { stdout } = await execFileAsync("curl.exe", args, {
      timeout: input.timeoutMs + 2_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const marker = "\n__MOSS_HTTP_CODE__:";
    const idx = stdout.lastIndexOf(marker);
    const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
    const rawCode = idx >= 0 ? stdout.slice(idx + marker.length).trim() : "";
    const statusCode = /^\d{3}$/u.test(rawCode) ? Number(rawCode) : null;
    return {
      ok: statusCode !== null && statusCode > 0,
      statusCode,
      latencyMs: Math.max(1, Date.now() - start),
      body,
    };
  } catch (error) {
    const msg = error instanceof Error ? redactWatchdogText(error.message) : "curl error";
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.max(1, Date.now() - start),
      body: "",
      error: msg,
    };
  }
}

export function classifyDaysRemaining(daysRemaining: number | null): HealthLevel {
  if (daysRemaining === null) return "warn";
  if (daysRemaining <= 3) return "bad";
  if (daysRemaining <= 14) return "warn";
  return "ok";
}

export function computeDaysRemaining(dateIso: string, nowMs: number): number | null {
  const parsed = Date.parse(dateIso.length <= 10 ? `${dateIso}T23:59:59+08:00` : dateIso);
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil((parsed - nowMs) / 86_400_000);
}

export async function defaultTlsProbe(
  host: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  nowMs = Date.now(),
): Promise<TlsCertResult> {
  return await new Promise<TlsCertResult>((resolve) => {
    const socket = tlsConnect(
      { host, port: 443, servername: host, rejectUnauthorized: true },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
          const iso = validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null;
          const days = iso ? computeDaysRemaining(iso, nowMs) : null;
          resolve({
            host,
            ok: iso !== null && (days ?? 0) > 0,
            expiresAt: iso ? iso.slice(0, 10) : null,
            daysRemaining: days,
            level: classifyDaysRemaining(days),
          });
        } finally {
          socket.end();
        }
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve({
        host,
        ok: false,
        expiresAt: null,
        daysRemaining: null,
        level: "warn",
        error: "TLS 握手超时",
      });
    });
    socket.on("error", (err: Error) => {
      resolve({
        host,
        ok: false,
        expiresAt: null,
        daysRemaining: null,
        level: "bad",
        error: redactWatchdogText(err.message),
      });
    });
  });
}

export async function defaultPostBoardAlert(input: {
  readonly channel: string;
  readonly actor: string;
  readonly message: string;
}): Promise<void> {
  const vercelBin =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? "", "npm", "vercel.cmd") || "vercel.cmd"
      : "vercel";
  if (process.platform === "win32") {
    await execFileAsync(
      "cmd.exe",
      ["/c", vercelBin, "board", "post", input.channel, input.message, "--as", input.actor],
      { timeout: 15_000, windowsHide: true },
    );
    return;
  }
  await execFileAsync(
    vercelBin,
    ["board", "post", input.channel, input.message, "--as", input.actor],
    { timeout: 15_000 },
  );
}

function evaluateEndpointLane(
  spec: EndpointSpec,
  probe: HttpProbeResult,
): { readonly ok: boolean; readonly error: string | null } {
  if (probe.statusCode === null) {
    return { ok: false, error: probe.error ? "连接失败" : "无响应" };
  }
  if (probe.statusCode !== spec.expectedStatus) {
    return { ok: false, error: `HTTP ${probe.statusCode}` };
  }
  const bodyError = spec.verifyBody ? spec.verifyBody(probe.body) : null;
  if (bodyError) {
    return { ok: false, error: bodyError };
  }
  return { ok: true, error: null };
}

function combineLaneStatus(input: {
  readonly requireDirect: boolean;
  readonly directOk: boolean;
  readonly directError: string | null;
  readonly proxyOk: boolean | null;
  readonly proxyError: string | null;
}): { readonly status: HealthLevel; readonly detail: string } {
  if (input.requireDirect) {
    if (!input.directOk) {
      return {
        status: "bad",
        detail: `直连异常（${input.directError ?? "失败"}）${input.proxyOk === true ? "，代理可通" : ""}`,
      };
    }
    if (input.proxyOk === false) {
      return {
        status: "warn",
        detail: `直连正常，代理探测异常（${input.proxyError ?? "失败"}）`,
      };
    }
    return { status: "ok", detail: "国内直连与代理探测均正常" };
  }
  // Overseas-only endpoint: direct OR proxy ok means service is up; only HTTP/both-failed is bad.
  if (input.directOk) {
    return { status: "ok", detail: "海外链路响应正常" };
  }
  if (input.proxyOk === true) {
    return { status: "ok", detail: "经代理探测海外链路正常（直连受网络限制）" };
  }
  return {
    status: "bad",
    detail: `海外链路异常（直连：${input.directError ?? "失败"}${input.proxyError ? `，代理：${input.proxyError}` : ""}）`,
  };
}

export async function runWatchdogOnce(deps: WatchdogDependencies = {}): Promise<{
  readonly status: WatchdogStatusDocument;
  readonly alerted: boolean;
  readonly transitions: ReadonlyArray<string>;
}> {
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const statusPath = deps.statusPath ?? DEFAULT_STATUS_PATH;
  const logPath = deps.logPath ?? DEFAULT_LOG_PATH;
  const boardChannel = deps.boardChannel ?? DEFAULT_BOARD_CHANNEL;
  const boardActor = deps.boardActor ?? DEFAULT_BOARD_ACTOR;
  const manifestPublicKey = deps.manifestPublicKey ?? MOSS_UPDATE_MANIFEST_PUBLIC_KEY;
  const proxyUrl = deps.proxyUrl !== undefined ? deps.proxyUrl : detectConfiguredProxyUrl();
  const httpProbe = deps.httpProbe ?? defaultHttpProbe;
  const tlsProbe = deps.tlsProbe ?? ((host, timeoutMs) => defaultTlsProbe(host, timeoutMs, nowMs));
  const postBoardAlert = deps.postBoardAlert ?? defaultPostBoardAlert;

  let previousDoc: WatchdogStatusDocument | null = null;
  try {
    const rawPrev = readFileSync(statusPath, "utf8");
    const parsed = parseJsonSafe(rawPrev);
    if (parsed && Array.isArray(parsed.services)) {
      previousDoc = parsed as unknown as WatchdogStatusDocument;
    }
  } catch {
    previousDoc = null;
  }

  const endpointChecksPromise = Promise.all(
    ENDPOINT_SPECS.map(async (spec): Promise<WatchdogCheckRecord> => {
      const directProbe = await httpProbe({
        url: spec.url,
        method: spec.method,
        proxyUrl: null,
        timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      });
      const directEval = evaluateEndpointLane(spec, directProbe);

      let proxyOk: boolean | null = null;
      let proxyError: string | null = null;
      let proxyProbe: HttpProbeResult | null = null;
      if (proxyUrl) {
        proxyProbe = await httpProbe({
          url: spec.url,
          method: spec.method,
          proxyUrl,
          timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
        });
        const proxyEval = evaluateEndpointLane(spec, proxyProbe);
        proxyOk = proxyEval.ok;
        proxyError = proxyEval.error;
      }

      const combined = combineLaneStatus({
        requireDirect: spec.requireDirect,
        directOk: directEval.ok,
        directError: directEval.error,
        proxyOk,
        proxyError,
      });
      const bestStatus = directProbe.statusCode ?? proxyProbe?.statusCode ?? null;
      const bestLatency = directEval.ok
        ? directProbe.latencyMs
        : (proxyProbe?.latencyMs ?? directProbe.latencyMs);

      return {
        id: spec.id,
        slot: spec.slot,
        name: spec.name,
        url: spec.url,
        status: combined.status,
        ok: combined.status === "ok",
        directOk: directEval.ok,
        proxyOk,
        httpStatus: bestStatus,
        latencyMs: bestLatency,
        label:
          combined.status === "ok"
            ? `正常 · ${bestLatency} 毫秒`
            : combined.status === "warn"
              ? "需要关注"
              : directEval.error || proxyError || "连接异常",
        plainDetail: combined.detail,
      };
    }),
  );

  const manifestChecksPromise = Promise.all(
    MANIFEST_SPECS.map(async (spec): Promise<WatchdogCheckRecord> => {
      const checkLane = async (laneProxy: string | null) => {
        const [manifestProbe, sigProbe] = await Promise.all([
          httpProbe({
            url: spec.manifestUrl,
            method: "GET",
            proxyUrl: laneProxy,
            timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
          }),
          httpProbe({
            url: spec.signatureUrl,
            method: "GET",
            proxyUrl: laneProxy,
            timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
          }),
        ]);
        if (manifestProbe.statusCode !== 200) {
          return {
            ok: false,
            statusCode: manifestProbe.statusCode,
            latencyMs: manifestProbe.latencyMs,
            error:
              manifestProbe.statusCode === null
                ? "清单下载失败"
                : `清单 HTTP ${manifestProbe.statusCode}`,
          };
        }
        if (sigProbe.statusCode !== 200) {
          return {
            ok: false,
            statusCode: sigProbe.statusCode,
            latencyMs: manifestProbe.latencyMs,
            error:
              sigProbe.statusCode === null ? "签名下载失败" : `签名 HTTP ${sigProbe.statusCode}`,
          };
        }
        const sigOk = verifyMossUpdateManifest({
          channelFile: spec.channelFile,
          manifest: manifestProbe.body,
          signature: sigProbe.body,
          manifestPublicKey,
        });
        if (!sigOk) {
          return {
            ok: false,
            statusCode: 200,
            latencyMs: manifestProbe.latencyMs,
            error: "Ed25519 签名校验失败",
          };
        }
        return {
          ok: true,
          statusCode: 200,
          latencyMs: manifestProbe.latencyMs,
          error: null,
        };
      };

      const directRes = await checkLane(null);
      const proxyRes = proxyUrl ? await checkLane(proxyUrl) : null;
      const combined = combineLaneStatus({
        requireDirect: spec.requireDirect,
        directOk: directRes.ok,
        directError: directRes.error,
        proxyOk: proxyRes ? proxyRes.ok : null,
        proxyError: proxyRes ? proxyRes.error : null,
      });
      const bestLatency = directRes.ok
        ? directRes.latencyMs
        : (proxyRes?.latencyMs ?? directRes.latencyMs);

      return {
        id: spec.id,
        slot: spec.slot,
        name: spec.name,
        url: spec.manifestUrl,
        status: combined.status,
        ok: combined.status === "ok",
        directOk: directRes.ok,
        proxyOk: proxyRes ? proxyRes.ok : null,
        httpStatus: directRes.statusCode ?? proxyRes?.statusCode ?? null,
        latencyMs: bestLatency,
        label:
          combined.status === "ok"
            ? `验签通过 · ${bestLatency} 毫秒`
            : combined.status === "warn"
              ? "需要关注"
              : directRes.error || proxyRes?.error || "校验异常",
        plainDetail:
          combined.status === "ok" ? `${spec.name} 清单下载与 Ed25519 验签正常` : combined.detail,
      };
    }),
  );

  const tlsResultsPromise = Promise.all(
    TLS_HOSTS.map((host) => tlsProbe(host, DEFAULT_PROBE_TIMEOUT_MS)),
  );

  const [endpointChecks, manifestChecks, tlsCerts] = await Promise.all([
    endpointChecksPromise,
    manifestChecksPromise,
    tlsResultsPromise,
  ]);
  const checks = [...endpointChecks, ...manifestChecks];

  const slotOrder: ReadonlyArray<CockpitSlotId> = [
    "cn-chat",
    "global-chat",
    "cn-voice",
    "global-voice",
    "pay",
    "share",
    "updates",
  ];
  const services: CockpitServiceSummary[] = slotOrder.map((slotId) => {
    const items = checks.filter((c) => c.slot === slotId);
    const hasBad = items.some((c) => c.status === "bad");
    const hasWarn = items.some((c) => c.status === "warn");
    const status: HealthLevel = hasBad ? "bad" : hasWarn ? "warn" : "ok";
    const meta = SLOT_META[slotId];
    const maxLatency = items.reduce((max, item) => Math.max(max, item.latencyMs), 0);
    const badItem = items.find((c) => c.status === "bad");
    const warnItem = items.find((c) => c.status === "warn");
    const firstHttpStatus = badItem?.httpStatus ?? items[0]?.httpStatus ?? null;
    const directOk = items.every((c) => c.directOk);
    const proxyOk = items.some((c) => c.proxyOk !== null)
      ? items.every((c) => c.proxyOk !== false)
      : null;

    return {
      id: slotId,
      name: meta.name,
      region: meta.region,
      status,
      label:
        status === "ok"
          ? `正常 · ${maxLatency} 毫秒`
          : status === "warn"
            ? warnItem?.label || "需要关注"
            : badItem?.label || "连接异常",
      plainDetail:
        status === "ok"
          ? slotId === "updates"
            ? "COS 与 R2 桌面/安卓清单与 Ed25519 验签均正常"
            : "核心链路与直连/代理探测均正常"
          : (badItem?.plainDetail ?? warnItem?.plainDetail ?? "部分检查项异常"),
      directOk,
      proxyOk,
      latencyMs: maxLatency,
      httpStatus: firstHttpStatus,
    };
  });

  const earliestCert = tlsCerts
    .filter((c) => c.expiresAt !== null && c.daysRemaining !== null)
    .toSorted((a, b) => (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999))[0];
  const failedCert = tlsCerts.find((c) => !c.ok);

  const tldrawDays = computeDaysRemaining(FIXED_EXPIRIES.tldraw.expiresAt, nowMs);
  const cvmDays = computeDaysRemaining(FIXED_EXPIRIES.cvm.expiresAt, nowMs);

  const countdowns: CountdownSummary[] = [
    {
      id: "tldraw",
      name: FIXED_EXPIRIES.tldraw.name,
      expiresAt: FIXED_EXPIRIES.tldraw.expiresAt,
      daysRemaining: tldrawDays,
      level: classifyDaysRemaining(tldrawDays),
      hint: FIXED_EXPIRIES.tldraw.hint,
    },
    {
      id: "cert",
      name: "线上域名 TLS 证书（最早到期）",
      expiresAt: earliestCert?.expiresAt ?? "未知",
      daysRemaining: earliestCert?.daysRemaining ?? null,
      level: failedCert ? "bad" : (earliestCert?.level ?? "warn"),
      hint: failedCert
        ? `${failedCert.host} 证书异常（${failedCert.error ?? "失败"}）；已退役域名不计入告警`
        : earliestCert
          ? `最早到期域名为 ${earliestCert.host}；旧域名 moss-cn-realtime.inkcomicai.com 已退役`
          : "TLS 证书到期日检测未完成",
    },
    {
      id: "cvm",
      name: FIXED_EXPIRIES.cvm.name,
      expiresAt: FIXED_EXPIRIES.cvm.expiresAt,
      daysRemaining: cvmDays,
      level: classifyDaysRemaining(cvmDays),
      hint: FIXED_EXPIRIES.cvm.hint,
    },
  ];

  const badServices = services.filter((s) => s.status === "bad");
  const warnServices = services.filter((s) => s.status === "warn");
  const hasBadCert = tlsCerts.some((c) => c.level === "bad");
  const overall: HealthLevel =
    badServices.length > 0 || hasBadCert ? "bad" : warnServices.length > 0 ? "warn" : "ok";
  const summaryLabel =
    badServices.length > 0
      ? `${badServices.length} 项服务异常`
      : hasBadCert
        ? "存在即将到期或异常的 TLS 证书"
        : warnServices.length > 0
          ? `${warnServices.length} 项服务需关注`
          : "全部核心服务正常";

  const doc: WatchdogStatusDocument = {
    schemaVersion: 1,
    updatedAt: nowIso,
    checkedAt: nowIso,
    overall,
    summaryLabel,
    services,
    checks,
    countdowns,
    tlsCerts,
    retiredHosts: RETIRED_HOSTS,
  };

  // Atomic write health-status.json
  mkdirSync(dirname(statusPath), { recursive: true });
  const tmpPath = `${statusPath}.tmp.${process.pid}.${nowMs}`;
  writeFileSync(tmpPath, redactWatchdogText(`${JSON.stringify(doc, null, 2)}\n`), "utf8");
  renameSync(tmpPath, statusPath);

  // Append watchdog.log
  mkdirSync(dirname(logPath), { recursive: true });
  const badNames = badServices.map((s) => `${s.id}(${s.label})`).join(",");
  const logLine = `${nowIso} overall=${overall} checks=${checks.filter((c) => c.ok).length}/${checks.length} bad=[${badNames}] earliest_tls=${earliestCert ? `${earliestCert.host}:${earliestCert.daysRemaining}d` : "n/a"} tldraw=${tldrawDays}d cvm=${cvmDays}d\n`;
  appendFileSync(logPath, redactWatchdogText(logLine), "utf8");

  // Detect green -> red transitions
  const transitions = detectGreenToRedTransitions(previousDoc, doc);
  let alerted = false;
  if (transitions.length > 0) {
    const alertText = redactWatchdogText(
      `【线上巡检告警】发现服务由正常转为异常（${nowIso}）：\n${transitions.map((t) => `- ${t}`).join("\n")}\n详情已写入 D:\\DevTemp\\moss-ops\\health-status.json。`,
    );
    try {
      await postBoardAlert({ channel: boardChannel, actor: boardActor, message: alertText });
      alerted = true;
    } catch {
      // Alert failure must not prevent status file persistence.
    }
  }

  return { status: doc, alerted, transitions };
}

export function detectGreenToRedTransitions(
  previous: WatchdogStatusDocument | null,
  current: WatchdogStatusDocument,
): ReadonlyArray<string> {
  if (!previous) return [];
  const transitions: string[] = [];
  const prevById = new Map(previous.services.map((s) => [s.id, s]));
  for (const service of current.services) {
    const prev = prevById.get(service.id);
    if (prev && prev.status !== "bad" && service.status === "bad") {
      transitions.push(
        `${service.name}（${service.region}）：${service.label} — ${service.plainDetail}`,
      );
    }
  }
  if (transitions.length === 0 && previous.overall !== "bad" && current.overall === "bad") {
    transitions.push(`整体状态变为异常：${current.summaryLabel}`);
  }
  return transitions;
}

if (import.meta.main) {
  const result = await runWatchdogOnce();
  process.stdout.write(
    `${JSON.stringify({
      ok: result.status.overall !== "bad",
      overall: result.status.overall,
      summaryLabel: result.status.summaryLabel,
      alerted: result.alerted,
      transitions: result.transitions,
    })}\n`,
  );
  if (result.status.overall === "bad") {
    process.exitCode = 1;
  }
}
