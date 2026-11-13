import { redactDiagnosticText } from "./diagnosticsRedaction";

export const MOSS_DEVS_PUBLIC_REPORT_URL = "https://devs.mossbotai.com/reports";
/**
 * The same queue under its older hostname. A request that fails below HTTP on the public URL
 * is sent here once; every report request carries the report ID, which the queue
 * deduplicates, so a repeat changes nothing.
 */
export const MOSS_DEVS_FALLBACK_REPORT_URL = "https://moss-devs.inkcomicai.com/reports";

/** Developer reports are on. The user confirms each one, seeing exactly what will be sent. */
export const MOSS_DEVS_REPORTS_ENABLED = true;

/** The server refuses reports with this message while the error-report switch is off. */
export const DEVS_CONSENT_REQUIRED_MESSAGE =
  "Developer reports are off because Send error reports is off. Turn it on in Settings › Privacy to send one.";

/**
 * Daily caps. They bound what a flood of public reports can cost: the queue accepts at most
 * the report cap a day, the worker runs at most the job cap, and one installation may send at
 * most the installation cap. Installation IDs can be forged, so only the global caps are a
 * hard bound.
 */
export const DEVS_DEFAULT_DAILY_REPORT_LIMIT = 20;
export const DEVS_DEFAULT_DAILY_JOB_LIMIT = 20;
export const DEVS_DEFAULT_INSTALL_DAILY_LIMIT = 3;

/** A configured daily cap, or the fallback when it is missing or not a whole number 0-10000. */
export function readDevsDailyLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || Number.NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : fallback;
}

/** The UTC calendar day that daily caps count against. */
export const devsUtcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Seconds until the next UTC day, when the daily caps reset. */
export const devsSecondsUntilNextDay = (now: number) =>
  Math.max(1, Math.ceil((Date.parse(`${devsUtcDay(now)}T00:00:00Z`) + 86_400_000 - now) / 1000));

/**
 * A report only when the message starts with `@devs`. A mention anywhere else is ordinary chat
 * text, so quoting or discussing the feature never sends anything.
 */
export function parseDevsInvocation(text: string): {
  description: string;
  engine?: "claude" | "codex";
} | null {
  const match = /^\s*@devs(?=$|[\s:：,，])/i.exec(text);
  if (!match) return null;
  const description = text
    .slice(match[0].length)
    .trim()
    .replace(/^[:,，：\s]+/, "");
  const engine = /^(claude|codex)(?=\s|[:：]|$)/i.exec(description);
  if (!engine) return { description };
  return {
    description: description.slice(engine[0].length).replace(/^[:,，：\s]+/, ""),
    engine: engine[0].toLowerCase() as "claude" | "codex",
  };
}

const REDACTED = "[redacted]";
const keepName = (_match: string, name: unknown, separator: unknown) =>
  `${String(name)}${String(separator)}${REDACTED}`;
const keepFileName = (_match: string, name: unknown) =>
  typeof name === "string" && name ? `<path>/${name}` : "<path>";

/** Runs after the shared diagnostics rules, which do not cover these shapes in prose. */
const DEVS_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: unknown[]) => string);
}> = [
  // Credentials named in prose: "my password is hunter2", "token: x", "密码是 abc123".
  {
    pattern:
      /\b(pass(?:word|wd|code|phrase)|pwd|secret|api[ _-]?key|access[ _-]?key|private[ _-]?key|token|cookie)(\s*(?:is|was|=|:|：)\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replace: keepName,
  },
  {
    pattern:
      /(密码|口令|密钥|秘钥|令牌|验证码|授权码|私钥)(\s*(?:是|为|=|:|：)\s*)([^\s，。,;；]+)/g,
    replace: keepName,
  },
  // Key shapes the shared rules only catch when they are 32 characters or longer.
  {
    pattern:
      /\b(?:moss_sk_|sk_(?:live|test)_|rk_(?:live|test)_|pk_live_|glpat-|npm_|hf_|xai-|pypi-|dop_v1_|shpat_|ya29\.)[A-Za-z0-9_.-]{6,}/g,
    replace: REDACTED,
  },
  // A run mixing upper and lower case with digits is a credential, not a word.
  {
    pattern: /\b[A-Za-z0-9_-]{16,}\b/g,
    replace: (match) =>
      /[0-9]/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match) ? REDACTED : match,
  },
  // Email addresses with non-ASCII names or domains.
  {
    pattern: /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu,
    replace: "<email>",
  },
  // Phone numbers: mainland China mobiles and landlines, international and grouped numbers.
  {
    pattern: /(?<![\d.])(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d{4}){2}(?!\d|\.\d)/g,
    replace: "<phone>",
  },
  { pattern: /(?<![\d.])0\d{2,3}-\d{7,8}(?!\d|\.\d)/g, replace: "<phone>" },
  {
    pattern: /(?<![\w+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?!\d|\.\d)/g,
    replace: (match) => (match.replace(/\D/g, "").length >= 8 ? "<phone>" : match),
  },
  { pattern: /(?<![\d.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d|\.\d)/g, replace: "<phone>" },
  // Absolute paths outside the home directory keep only their file name.
  { pattern: /(?<![\w:])\\{1,2}[^\s\\'"]+\\[^\s'"]+/g, replace: "<path>" },
  {
    pattern: /(?<!\w)[A-Za-z]:[\\/](?:[^\s\\/'"()<>]+[\\/])*([^\s\\/'"()<>]*)/g,
    replace: keepFileName,
  },
  {
    pattern: /(?<![\w.:/~<>\]-])\/(?:[^\s/'"()<>]+\/)+([^\s/'"()<>]*)/g,
    replace: keepFileName,
  },
];

/**
 * Redaction for text that leaves the app in a developer report: the shared diagnostics rules
 * plus credentials named in prose, short key shapes, phone numbers and absolute paths. The
 * app shows its output in the confirmation, and the queue runs it again.
 */
export function redactDevsReportText(text: string, maxLength: number): string {
  let output = redactDiagnosticText(text, { maxLength });
  for (const rule of DEVS_RULES) {
    rule.pattern.lastIndex = 0;
    output =
      typeof rule.replace === "string"
        ? output.replace(rule.pattern, rule.replace)
        : output.replace(rule.pattern, rule.replace);
  }
  return output.length > maxLength ? `${output.slice(0, Math.max(0, maxLength - 1))}…` : output;
}

/**
 * Attachments a report may carry: composer images (re-encoded by the app, which drops their
 * metadata) and small text files (redacted like the description). The app, the server, the
 * queue and the worker all enforce these limits.
 */
export const DEVS_ATTACHMENT_LIMITS = {
  /** Five, so a 分享反馈 report with its five screenshots fits one job. */
  maxCount: 5,
  imageBytes: 400_000,
  textBytes: 64_000,
  totalBytes: 2_000_000,
  /** Longest image edge after the app re-encodes it. */
  imageEdge: 1_600,
} as const;
export type DevsAttachmentKind = "image" | "text";
export type DevsAttachmentMimeType = "image/jpeg" | "image/webp" | "image/png" | "text/plain";
/** What a report says it carries, before the bytes are uploaded separately. */
export interface DevsAttachmentManifestEntry {
  name: string;
  kind: DevsAttachmentKind;
  mimeType: DevsAttachmentMimeType;
  size: number;
  sha256: string;
}
const ATTACHMENT_TYPES: Record<DevsAttachmentMimeType, DevsAttachmentKind> = {
  "image/jpeg": "image",
  "image/webp": "image",
  "image/png": "image",
  "text/plain": "text",
};

/** A display name with no folders, control characters or personal details, at most 120 characters. */
export function devsAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const printable = [...base]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("");
  const cleaned = redactDevsReportText(printable.trim(), 120).trim();
  return cleaned || "attachment";
}

/** True when the bytes are what the declared type says: an image's signature, or UTF-8 text. */
export function devsAttachmentBytesMatch(mimeType: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  switch (mimeType) {
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return (
        starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
      );
    case "text/plain":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return !bytes.includes(0);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Validates a manifest from an untrusted caller; returns null when anything is out of bounds. */
export function parseDevsAttachmentManifest(value: unknown): DevsAttachmentManifestEntry[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DEVS_ATTACHMENT_LIMITS.maxCount) return null;
  const entries: DevsAttachmentManifestEntry[] = [];
  let total = 0;
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const { name, kind, mimeType, size, sha256 } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      name.length > 300 ||
      typeof mimeType !== "string" ||
      !(mimeType in ATTACHMENT_TYPES) ||
      kind !== ATTACHMENT_TYPES[mimeType as DevsAttachmentMimeType] ||
      !Number.isSafeInteger(size) ||
      (size as number) < 1 ||
      (size as number) >
        (kind === "image" ? DEVS_ATTACHMENT_LIMITS.imageBytes : DEVS_ATTACHMENT_LIMITS.textBytes) ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256)
    )
      return null;
    total += size as number;
    entries.push({
      name: devsAttachmentName(name),
      kind: kind as DevsAttachmentKind,
      mimeType: mimeType as DevsAttachmentMimeType,
      size: size as number,
      sha256,
    });
  }
  return total <= DEVS_ATTACHMENT_LIMITS.totalBytes ? entries : null;
}
