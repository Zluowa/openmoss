import { createHash, createHmac, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

const DEFAULT_APP_URL = "moss://app/index.html";
const DEFAULT_CDP_URL = "http://127.0.0.1:9230";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_SMS_TIMEOUT_MS = 90_000;

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Set(["localhost", "127.0.0.1", "::1"]).has(host);
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("invalid numeric option");
  return parsed;
}

function cleanCdpUrl(value) {
  const parsed = new URL(value);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error("CDP endpoint must be loopback-only");
  }
  return parsed.toString().replace(/\/$/, "");
}

function cleanAppUrl(value) {
  const parsed = new URL(value);
  if (
    !["http:", "https:", "moss:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search
  ) {
    throw new Error("invalid app URL");
  }
  if (parsed.protocol === "moss:") {
    if (parsed.hostname !== "app" || parsed.port || parsed.pathname !== "/index.html") {
      throw new Error("packaged app URL must target Moss");
    }
  } else if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("development app URL must be loopback-only");
  }
  parsed.hash = "";
  return parsed.toString();
}

function readRequiredSecret(env, name) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readRequiredTemplateCode(env) {
  const value = env.ALIYUN_SMS_TEMPLATE_CODE_LOGIN;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/u.test(value) ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error("ALIYUN_SMS_TEMPLATE_CODE_LOGIN is required");
  }
  return value;
}

function readRestartReceiptPath(env) {
  const value = env.MOSS_PHONE_E2E_RESTART_RECEIPT_PATH;
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new Error("MOSS_PHONE_E2E_RESTART_RECEIPT_PATH must be an absolute path");
  }
  return value;
}

export function normalizeMainlandPhone(raw) {
  if (typeof raw !== "string") throw new Error("MOSS_PHONE_E2E_PHONE is required");
  const compact = raw.trim().replace(/[\s().-]/gu, "");
  const domestic = compact.startsWith("+86")
    ? compact.slice(3)
    : compact.startsWith("86") && compact.length === 13
      ? compact.slice(2)
      : compact;
  if (!/^1[3-9]\d{9}$/u.test(domestic)) {
    throw new Error("MOSS_PHONE_E2E_PHONE is invalid");
  }
  return domestic;
}

export function parseMossPhoneE2EOptions(argv, env) {
  const cli = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--expect-saved-session") {
      cli.expectSavedSession = true;
      continue;
    }
    if (arg === "--arm-restart-receipt") {
      cli.armRestartReceipt = true;
      continue;
    }
    if (arg === "--logout-on-success") {
      cli.logoutOnSuccess = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error("missing option value");
    const optionByFlag = {
      "--app-url": "appUrl",
      "--cdp-url": "cdpUrl",
      "--sms-timeout-ms": "smsTimeoutMs",
      "--timeout-ms": "timeoutMs",
    };
    const key = optionByFlag[arg];
    if (!key) throw new Error("unknown option");
    cli[key] = next;
    index += 1;
  }

  const expectSavedSession =
    cli.expectSavedSession === true ||
    /^(?:1|true)$/iu.test(env.MOSS_PHONE_E2E_EXPECT_SAVED_SESSION ?? "");
  const armRestartReceipt =
    cli.armRestartReceipt === true ||
    /^(?:1|true)$/iu.test(env.MOSS_PHONE_E2E_ARM_RESTART_RECEIPT ?? "");
  if (expectSavedSession && armRestartReceipt) {
    throw new Error("restart receipt modes are mutually exclusive");
  }
  const logoutOnSuccess =
    cli.logoutOnSuccess === true ||
    /^(?:1|true)$/iu.test(env.MOSS_PHONE_E2E_LOGOUT_ON_SUCCESS ?? "");
  const sensitiveNames = [
    "MOSS_PHONE_E2E_PHONE",
    "ALIYUN_SMS_AUDIT_ACCESS_KEY_ID",
    "ALIYUN_SMS_AUDIT_ACCESS_KEY_SECRET",
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
  ];
  if (
    (expectSavedSession || armRestartReceipt) &&
    sensitiveNames.some((name) => env[name] !== undefined)
  ) {
    throw new Error("session-only verification must not receive login credentials");
  }
  if ((!expectSavedSession || armRestartReceipt) && logoutOnSuccess) {
    throw new Error("fresh login must be retained for restart verification");
  }

  const common = {
    help: false,
    appUrl: cleanAppUrl(cli.appUrl ?? env.MOSS_PHONE_E2E_APP_URL ?? DEFAULT_APP_URL),
    cdpUrl: cleanCdpUrl(cli.cdpUrl ?? env.MOSS_PHONE_E2E_CDP_URL ?? DEFAULT_CDP_URL),
    armRestartReceipt,
    expectSavedSession,
    logoutOnSuccess,
    restartReceiptPath: readRestartReceiptPath(env),
    smsTimeoutMs: readPositiveInteger(
      cli.smsTimeoutMs ?? env.MOSS_PHONE_E2E_SMS_TIMEOUT_MS,
      DEFAULT_SMS_TIMEOUT_MS,
    ),
    timeoutMs: readPositiveInteger(
      cli.timeoutMs ?? env.MOSS_PHONE_E2E_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
  };
  if (expectSavedSession || armRestartReceipt) return common;

  return {
    ...common,
    phone: normalizeMainlandPhone(env.MOSS_PHONE_E2E_PHONE),
    aliyunAccessKeyId: readRequiredSecret(env, "ALIYUN_SMS_AUDIT_ACCESS_KEY_ID"),
    aliyunAccessKeySecret: readRequiredSecret(env, "ALIYUN_SMS_AUDIT_ACCESS_KEY_SECRET"),
    aliyunRegion: String(env.ALIYUN_SMS_REGION ?? "cn-hangzhou").trim() || "cn-hangzhou",
    aliyunTemplateCode: readRequiredTemplateCode(env),
  };
}

export function buildAppHashRoute(appUrl, route) {
  if (!route.startsWith("/")) throw new Error("route must start with a slash");
  const target = new URL(appUrl);
  target.search = "";
  target.hash = route;
  return target.toString();
}

export function appPageMatches(pageUrl, appUrl) {
  try {
    const page = new URL(pageUrl);
    const app = new URL(appUrl);
    return (
      page.protocol === app.protocol &&
      page.hostname === app.hostname &&
      page.port === app.port &&
      page.pathname === app.pathname
    );
  } catch {
    return false;
  }
}

export function createAcceptanceMarker() {
  return `MOSS_ACCOUNT_CHAT_OK_${randomBytes(8).toString("hex")}`;
}

export function createProfileMarker() {
  return randomBytes(32).toString("hex");
}

export function createRestartReceipt({ browserPid, profileMarker }) {
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0) {
    throw new Error("invalid Electron browser process");
  }
  if (!/^[a-f0-9]{64}$/u.test(profileMarker)) {
    throw new Error("invalid profile marker");
  }
  return {
    schemaVersion: 1,
    electronBrowserPid: browserPid,
    profileFingerprint: createHash("sha256").update(profileMarker).digest("hex"),
  };
}

export function restartReceiptMatches(receipt, { browserPid, profileMarker }) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.schemaVersion !== 1 ||
    !Number.isSafeInteger(receipt.electronBrowserPid) ||
    receipt.electronBrowserPid <= 0 ||
    !/^[a-f0-9]{64}$/u.test(receipt.profileFingerprint ?? "") ||
    !Number.isSafeInteger(browserPid) ||
    browserPid <= 0 ||
    typeof profileMarker !== "string"
  ) {
    return false;
  }
  const currentFingerprint = createHash("sha256").update(profileMarker).digest("hex");
  return (
    receipt.electronBrowserPid !== browserPid && receipt.profileFingerprint === currentFingerprint
  );
}

export function acceptancePrompt(marker) {
  if (!/^MOSS_ACCOUNT_CHAT_OK_[a-f0-9]{16}$/u.test(marker)) {
    throw new Error("invalid acceptance marker");
  }
  return `Reply with exactly ${marker} and nothing else. Do not use tools.`;
}

export function chatSubmissionWasObserved(snapshot) {
  return (
    snapshot.markerVisible === true ||
    snapshot.turnRunning === true ||
    snapshot.editorPresent === false ||
    snapshot.editorMatchesPrompt === false ||
    new Set(["preparing-worktree", "sending"]).has(snapshot.sendState)
  );
}

export function aliyunPercentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gu, "~");
}

export function buildAliyunQuerySendDetailsUrl({
  accessKeyId,
  accessKeySecret,
  date,
  nonce,
  phone,
  region,
  timestamp,
}) {
  const parameters = {
    AccessKeyId: accessKeyId,
    Action: "QuerySendDetails",
    CurrentPage: "1",
    Format: "JSON",
    PageSize: "50",
    PhoneNumber: phone,
    RegionId: region,
    SendDate: date,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: nonce,
    SignatureVersion: "1.0",
    Timestamp: timestamp,
    Version: "2017-05-25",
  };
  const canonical = Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${aliyunPercentEncode(key)}=${aliyunPercentEncode(value)}`)
    .join("&");
  const stringToSign = `GET&${aliyunPercentEncode("/")}&${aliyunPercentEncode(canonical)}`;
  const signature = createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  return `https://dysmsapi.aliyuncs.com/?Signature=${aliyunPercentEncode(signature)}&${canonical}`;
}

export function shanghaiDateStrings(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return [now, new Date(now.getTime() - 86_400_000)].map((value) =>
    formatter
      .formatToParts(value)
      .filter((part) => new Set(["year", "month", "day"]).has(part.type))
      .map((part) => part.value)
      .join(""),
  );
}

function parseShanghaiSmsTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    return null;
  }
  const timestamp = Date.parse(`${value.replace(" ", "T")}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function extractFreshSmsCode(payload, { notBeforeMs, templateCode }) {
  if (typeof templateCode !== "string" || templateCode.length === 0) return null;
  const rawDetails = payload?.SmsSendDetailDTOs?.SmsSendDetailDTO;
  const details = Array.isArray(rawDetails) ? rawDetails : rawDetails ? [rawDetails] : [];
  const candidates = [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    if (detail.TemplateCode !== templateCode) continue;
    const sentAt = parseShanghaiSmsTimestamp(detail.SendDate);
    const requestSecond = Math.floor(notBeforeMs / 1_000) * 1_000;
    if (sentAt === null || sentAt < requestSecond) continue;
    const content = typeof detail.Content === "string" ? detail.Content : "";
    const match = /(?:^|\D)(\d{6})(?:\D|$)/u.exec(content);
    if (!match?.[1]) continue;
    candidates.push({ code: match[1], sentAt });
  }
  candidates.sort((left, right) => right.sentAt - left.sentAt);
  return candidates[0]?.code ?? null;
}
