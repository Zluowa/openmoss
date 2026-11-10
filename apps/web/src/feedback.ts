// FILE: feedback.ts
// Purpose: Owns feedback categories, privacy-safe diagnostics, screenshot attachments, and delivery.
// Layer: Web feature logic
// Depends on: An explicitly configured Moss feedback endpoint (`VITE_FEEDBACK_ENDPOINT`, set by
//             the desktop build from ~/.moss-release/feedback.env or the release secret).

import { APP_BASE_NAME, APP_VERSION } from "./branding";
import { bytesToBase64, encodeDevsReportImage } from "./components/chat/devsReportAttachments";

/**
 * `lead` opens the reported summary in the reporter's voice, so the category is
 * readable as a sentence rather than as an enum value.
 */
export const FEEDBACK_CATEGORIES = [
  { value: "bug", label: "Bug", lead: "I ran into a bug" },
  { value: "session", label: "Session", lead: "I hit a session problem" },
  { value: "ui", label: "UI", lead: "Something looked wrong" },
  { value: "performance", label: "Performance", lead: `${APP_BASE_NAME} felt slow` },
  { value: "idea", label: "Idea", lead: "I have an idea" },
  { value: "other", label: "Other", lead: "I have some feedback" },
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]["value"];

const UNCATEGORIZED_LEAD = "I have some feedback";

export interface FeedbackThreadContext {
  provider: string | null;
  model: string | null;
  projectKind: string | null;
  environmentMode: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  sessionStatus: string | null;
  latestTurnState: string | null;
  messageCount: number;
  activityCount: number;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  hasThreadError: boolean;
}

export type FeedbackDiagnostics = FeedbackThreadContext & {
  appVersion: string;
  submittedAt: string;
  userAgent: string;
  platform: string;
  language: string;
  viewport: string;
};

/**
 * Screenshots the dialog takes: PNG, JPEG or WebP, five at most, 5 MB each. Before sending,
 * each is re-encoded like a developer report's images, which drops camera and location
 * metadata and keeps the report within what the developer queue stores.
 */
export const FEEDBACK_IMAGE_LIMITS = {
  maxCount: 5,
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/webp"],
} as const;

export type FeedbackImageRejection = "type" | "size" | "count";

const IMAGE_EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** The image type of a picked, pasted or dropped file; some sources leave `type` empty. */
export function feedbackImageType(file: { name: string; type: string }): string | null {
  const extension = /\.([a-z]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const type = file.type || IMAGE_EXTENSION_TYPES[extension] || "";
  return (FEEDBACK_IMAGE_LIMITS.mimeTypes as readonly string[]).includes(type) ? type : null;
}

/** Splits incoming files into those the dialog takes and the reasons the others are refused. */
export function acceptFeedbackImages<T extends { name: string; type: string; size: number }>(
  files: readonly T[],
  existingCount: number,
): { accepted: T[]; rejected: FeedbackImageRejection[] } {
  const accepted: T[] = [];
  const rejected: FeedbackImageRejection[] = [];
  for (const file of files) {
    if (!feedbackImageType(file)) rejected.push("type");
    else if (file.size > FEEDBACK_IMAGE_LIMITS.maxBytes) rejected.push("size");
    else if (existingCount + accepted.length >= FEEDBACK_IMAGE_LIMITS.maxCount)
      rejected.push("count");
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export interface FeedbackAttachment {
  name: string;
  mimeType: "image/webp";
  dataBase64: string;
}

/** Delivery failures, in words a person can act on; the service's own text never shows. */
export const FEEDBACK_IMAGE_UNREADABLE_MESSAGE =
  "One of the images could not be read. Remove it and try again.";
export const FEEDBACK_TOO_LARGE_MESSAGE =
  "The images are too large to send. Remove one and try again.";
export const FEEDBACK_RATE_LIMITED_MESSAGE =
  "Too much feedback was sent from this computer today. Please try again tomorrow.";
export const FEEDBACK_REJECTED_MESSAGE = "This feedback could not be accepted. Please try again.";
export const FEEDBACK_UNAVAILABLE_MESSAGE =
  "The feedback service is not available right now. Please try again later.";
export const FEEDBACK_NETWORK_MESSAGE =
  "Feedback could not be sent. Check your network connection and try again.";

/** Re-encodes the chosen screenshots for sending; fails when one cannot be read. */
export async function prepareFeedbackAttachments(
  files: readonly File[],
  encode: (file: Blob) => Promise<Uint8Array | null> = encodeDevsReportImage,
): Promise<FeedbackAttachment[]> {
  const attachments: FeedbackAttachment[] = [];
  for (const file of files.slice(0, FEEDBACK_IMAGE_LIMITS.maxCount)) {
    const bytes = await encode(file).catch(() => null);
    if (!bytes) throw new Error(FEEDBACK_IMAGE_UNREADABLE_MESSAGE);
    attachments.push({ name: file.name, mimeType: "image/webp", dataBase64: bytesToBase64(bytes) });
  }
  return attachments;
}

export interface FeedbackSubmission {
  /** Lets the developer queue recognise a retry of the same report. */
  id: string;
  category: FeedbackCategory | null;
  details: string;
  /** Reader-facing rendering of `diagnostics`; the reporter never sees or edits it. */
  summary: string;
  diagnostics: FeedbackDiagnostics;
  attachments?: FeedbackAttachment[];
}

/** Five screenshots take a while on a slow connection. */
const FEEDBACK_REQUEST_TIMEOUT_MS = 60_000;

function formatStateFlags(diagnostics: FeedbackThreadContext): string {
  const flags: string[] = [];
  if (diagnostics.hasThreadError) flags.push("the thread was in an error state");
  if (diagnostics.hasPendingApproval) flags.push("an approval was pending");
  if (diagnostics.hasPendingUserInput) flags.push("the agent was waiting for input");
  return flags.length > 0 ? `${flags.join(", ")}.` : "nothing pending.";
}

/**
 * Renders diagnostics as the report a maintainer reads first, since incoming
 * feedback arrives without any context about what the reporter was doing.
 */
export function formatFeedbackSummary(input: {
  category: FeedbackCategory | null;
  diagnostics: FeedbackDiagnostics;
}): string {
  const { diagnostics } = input;
  const category = FEEDBACK_CATEGORIES.find((option) => option.value === input.category);
  const lead = category?.lead ?? UNCATEGORIZED_LEAD;
  const usageContext = diagnostics.provider
    ? diagnostics.model
      ? `, using ${diagnostics.provider} with ${diagnostics.model}`
      : `, using ${diagnostics.provider}`
    : " outside an active chat";

  const rows: Array<[string, string | null]> = [
    ["Report type", category?.label ?? "Unspecified"],
    ["App version", diagnostics.appVersion],
    ["Provider", diagnostics.provider],
    ["Model", diagnostics.model],
    ["Project kind", diagnostics.projectKind],
    ["Environment mode", diagnostics.environmentMode],
    ["Runtime mode", diagnostics.runtimeMode],
    ["Interaction mode", diagnostics.interactionMode],
    ["Session status", diagnostics.sessionStatus],
    ["Latest turn state", diagnostics.latestTurnState],
    [
      "Thread size",
      `${diagnostics.messageCount} messages, ${diagnostics.activityCount} activities`,
    ],
    ["At submission", formatStateFlags(diagnostics)],
    ["Platform", `${diagnostics.platform}, viewport ${diagnostics.viewport}`],
    ["Language", diagnostics.language],
    ["User agent", diagnostics.userAgent],
    ["Submitted at", diagnostics.submittedAt],
  ];

  const detailLines = rows
    .filter((row): row is [string, string] => row[1] !== null && row[1] !== "")
    .map(([label, value]) => `${label}: ${value}`);

  return [
    `${lead} in ${APP_BASE_NAME} ${diagnostics.appVersion}${usageContext}.`,
    "",
    ...detailLines,
  ].join("\n");
}

export function buildFeedbackSubmission(input: {
  category: FeedbackCategory | null;
  details: string;
  context: FeedbackThreadContext;
  attachments?: FeedbackAttachment[];
  id?: string;
  now?: Date;
  userAgent?: string;
  platform?: string;
  language?: string;
  viewport?: { width: number; height: number };
}): FeedbackSubmission {
  const viewport = input.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const diagnostics: FeedbackDiagnostics = {
    ...input.context,
    appVersion: APP_VERSION,
    submittedAt: (input.now ?? new Date()).toISOString(),
    userAgent: input.userAgent ?? navigator.userAgent,
    platform: input.platform ?? navigator.platform,
    language: input.language ?? navigator.language,
    viewport: `${viewport.width}x${viewport.height}`,
  };

  return {
    id: input.id ?? crypto.randomUUID(),
    category: input.category,
    details: input.details.trim(),
    summary: formatFeedbackSummary({
      category: input.category,
      diagnostics,
    }),
    diagnostics,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };
}

function deliveryFailureMessage(status: number): string {
  if (status === 413) return FEEDBACK_TOO_LARGE_MESSAGE;
  if (status === 429) return FEEDBACK_RATE_LIMITED_MESSAGE;
  if (status >= 400 && status < 500) return FEEDBACK_REJECTED_MESSAGE;
  return FEEDBACK_UNAVAILABLE_MESSAGE;
}

class FeedbackDeliveryError extends Error {}

export function resolveFeedbackEndpoint(
  configuredEndpoint: string | undefined = import.meta.env.VITE_FEEDBACK_ENDPOINT,
): string | null {
  const candidate = configuredEndpoint?.trim();
  if (!candidate) return null;

  try {
    const endpoint = new URL(candidate);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return null;
    return endpoint.toString();
  } catch {
    return null;
  }
}

export function isFeedbackDeliveryConfigured(
  configuredEndpoint: string | undefined = import.meta.env.VITE_FEEDBACK_ENDPOINT,
): boolean {
  return resolveFeedbackEndpoint(configuredEndpoint) !== null;
}

export async function submitFeedback(
  submission: FeedbackSubmission,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const endpoint = resolveFeedbackEndpoint();
  if (!endpoint) {
    throw new Error("Feedback delivery is not configured for this Moss build.");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FEEDBACK_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moss-feedback": "1",
      },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return;
    throw new FeedbackDeliveryError(deliveryFailureMessage(response.status));
  } catch (error) {
    if (error instanceof FeedbackDeliveryError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Feedback delivery timed out. Please try again.", { cause: error });
    }
    throw new Error(FEEDBACK_NETWORK_MESSAGE, { cause: error });
  } finally {
    window.clearTimeout(timeout);
  }
}
