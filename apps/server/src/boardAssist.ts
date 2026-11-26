// FILE: boardAssist.ts
// Purpose: Server half of 板上 Moss: validates a board ask, builds the shared prompt, and
//          streams model lines (JSONL ops + final reply) through Moss's AI gateway.
// Layer: Server. One memoryless streamed completion per ask, using zero sync filesystem calls.

import type { ModelSelection } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import {
  BOARD_ASSIST_CAPABILITIES,
  BOARD_ASSIST_IMAGE_MIME_TYPES,
  BOARD_ASSIST_INPUT_LIMITS,
  BOARD_ASSIST_ISSUE_KINDS,
  buildBoardAssistPrompt,
  type BoardAssistAsk,
  type BoardAssistAttachment,
  type BoardAssistCapability,
  type BoardAssistCorrection,
  type BoardAssistCorrectionIssue,
  type BoardAssistHistoryEntry,
  type BoardAssistImage,
  type BoardAssistImageMimeType,
  type BoardAssistIssue,
  type BoardAssistIssueKind,
  type BoardAssistPin,
  type BoardAssistPinKind,
  type BoardAssistPlacedShape,
  type BoardAssistTier,
  type BoardAssistTierOverride,
} from "@moss/shared/spaceItems/boardAssist";
import type { BoardShapeSummary } from "@moss/shared/spaceItems/boardCanvas";
import { Effect } from "effect";

import type { PageAppAiGateway } from "./pages/apps/aiGateway";

export type BoardAssistEvent =
  | { readonly type: "start"; readonly tier: string }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done"; readonly model: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

const MAX_RUNNING = 4;

export const BOARD_ASSIST_MESSAGES: Record<string, string> = {
  authentication_required: "登录 Moss 账号后，板上 Moss 才能直接修改画布。",
  quota_exceeded: "Moss 额度用完了，充值后再试。",
  resource_exhausted: "模型正忙，请稍后再试。",
  unavailable: "板上 Moss 暂时连不上模型，请稍后再试。",
  upstream_error: "板上 Moss 暂时连不上模型，请稍后再试。",
};

let running = 0;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function area(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (!finite(value.x) || !finite(value.y)) return undefined;
  return {
    x: value.x,
    y: value.y,
    ...(finite(value.w) ? { w: value.w } : {}),
    ...(finite(value.h) ? { h: value.h } : {}),
  };
}

function readPin(value: unknown): BoardAssistPin | undefined {
  const base = area(value);
  if (!base) return undefined;
  const kindRaw = (value as Record<string, unknown>).kind;
  const kind: BoardAssistPinKind | undefined =
    kindRaw === "region" || kindRaw === "shape" || kindRaw === "point" ? kindRaw : undefined;
  return {
    ...base,
    ...(kind ? { kind } : {}),
  };
}

function readCapabilities(value: unknown): BoardAssistCapability[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<BoardAssistCapability>();
  for (const item of value.slice(0, 16)) {
    if (
      typeof item === "string" &&
      (BOARD_ASSIST_CAPABILITIES as readonly string[]).includes(item)
    ) {
      allowed.add(item as BoardAssistCapability);
    }
  }
  return [...allowed];
}

function readTierOverride(value: unknown): BoardAssistTierOverride | undefined {
  return value === "auto" || value === "quick" || value === "default" || value === "complex"
    ? value
    : undefined;
}

function readIssues(value: unknown): BoardAssistIssue[] {
  if (!Array.isArray(value)) return [];
  const out: BoardAssistIssue[] = [];
  for (const entry of value.slice(0, BOARD_ASSIST_INPUT_LIMITS.issues)) {
    if (!isRecord(entry) || typeof entry.kind !== "string" || !Array.isArray(entry.ids)) continue;
    if (!(BOARD_ASSIST_ISSUE_KINDS as readonly string[]).includes(entry.kind)) continue;
    const ids = entry.ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim().slice(0, 80))
      .slice(0, 24);
    if (ids.length === 0) continue;
    const detail =
      typeof entry.detail === "string" && entry.detail.trim()
        ? entry.detail.trim().slice(0, 200)
        : undefined;
    out.push({
      kind: entry.kind as BoardAssistIssueKind,
      ids,
      ...(detail ? { detail } : {}),
    });
  }
  return out;
}

function readHistory(value: unknown): BoardAssistHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: BoardAssistHistoryEntry[] = [];
  for (const entry of value.slice(-BOARD_ASSIST_INPUT_LIMITS.history)) {
    if (!isRecord(entry) || typeof entry.said !== "string" || typeof entry.did !== "string") {
      continue;
    }
    const said = entry.said.trim().slice(0, 400);
    const did = entry.did.trim().slice(0, 400);
    if (!said && !did) continue;
    out.push({
      said,
      did,
      ...(entry.undone === true ? { undone: true } : {}),
    });
  }
  return out;
}

function readAttachments(value: unknown): BoardAssistAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: BoardAssistAttachment[] = [];
  let remaining = BOARD_ASSIST_INPUT_LIMITS.attachmentTotalChars;
  for (const entry of value.slice(0, BOARD_ASSIST_INPUT_LIMITS.attachments)) {
    if (remaining <= 0) break;
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.text !== "string") {
      continue;
    }
    const name = entry.name.trim().slice(0, 120);
    const text = entry.text.slice(0, remaining);
    if (!name || !text) continue;
    remaining -= text.length;
    out.push({ name, text });
  }
  return out;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/u;

function readImages(value: unknown): BoardAssistImage[] {
  if (!Array.isArray(value)) return [];
  const out: BoardAssistImage[] = [];
  for (const entry of value.slice(0, BOARD_ASSIST_INPUT_LIMITS.images)) {
    if (
      !isRecord(entry) ||
      typeof entry.shapeId !== "string" ||
      typeof entry.mimeType !== "string" ||
      typeof entry.dataBase64 !== "string"
    ) {
      continue;
    }
    const shapeId = entry.shapeId.trim().slice(0, 80);
    if (
      !shapeId ||
      !(BOARD_ASSIST_IMAGE_MIME_TYPES as readonly string[]).includes(entry.mimeType)
    ) {
      continue;
    }
    const cleaned = entry.dataBase64.replace(/\s+/gu, "");
    if (
      cleaned.length === 0 ||
      cleaned.length > BOARD_ASSIST_INPUT_LIMITS.imageMaxBase64Chars ||
      !BASE64_PATTERN.test(cleaned)
    ) {
      continue;
    }
    out.push({
      shapeId,
      mimeType: entry.mimeType as BoardAssistImageMimeType,
      dataBase64: cleaned,
    });
  }
  return out;
}

function readCorrection(value: unknown): BoardAssistCorrection | undefined {
  if (!isRecord(value)) return undefined;
  const issues: BoardAssistCorrectionIssue[] = Array.isArray(value.issues)
    ? value.issues.slice(0, BOARD_ASSIST_INPUT_LIMITS.issues).flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.kind !== "string" || !Array.isArray(entry.ids)) {
          return [];
        }
        const kind = entry.kind.trim().slice(0, 60);
        const ids = entry.ids
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          .map((id) => id.trim().slice(0, 80))
          .slice(0, 24);
        if (!kind || ids.length === 0) return [];
        const detail =
          typeof entry.detail === "string" && entry.detail.trim()
            ? entry.detail.trim().slice(0, 200)
            : undefined;
        return [{ kind, ids, ...(detail ? { detail } : {}) }];
      })
    : [];
  const placed: BoardAssistPlacedShape[] = Array.isArray(value.placed)
    ? value.placed.slice(0, BOARD_ASSIST_INPUT_LIMITS.correctionPlaced).flatMap((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          !entry.id.trim() ||
          ![entry.x, entry.y, entry.w, entry.h].every(finite)
        ) {
          return [];
        }
        const text =
          typeof entry.text === "string" && entry.text.trim()
            ? entry.text.trim().slice(0, 200)
            : undefined;
        return [
          {
            id: entry.id.trim().slice(0, 80),
            x: entry.x as number,
            y: entry.y as number,
            w: entry.w as number,
            h: entry.h as number,
            ...(text ? { text } : {}),
          },
        ];
      })
    : [];
  if (issues.length === 0 && placed.length === 0) return undefined;
  return { issues, placed };
}

export interface BoardAssistRequestInput {
  readonly board: { readonly shapes: BoardShapeSummary[]; readonly truncated: boolean };
  readonly ask: BoardAssistAsk;
  readonly expectedBoard?: unknown;
}

/** Accepts only the fields the prompt uses; unrelated fields are dropped before prompting. */
export function readBoardAssistBody(body: unknown): BoardAssistRequestInput | null {
  if (!isRecord(body)) return null;
  const { board, ask, expectedBoard } = body as {
    board?: unknown;
    ask?: unknown;
    expectedBoard?: unknown;
  };
  if (!isRecord(ask)) return null;
  const raw = ask;
  if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 4_000) return null;
  if (raw.via !== "comment" && raw.via !== "composer") return null;

  const shapesRaw = (board as { shapes?: unknown } | null)?.shapes;
  const shapes = (Array.isArray(shapesRaw) ? shapesRaw : [])
    .slice(0, 400)
    .flatMap((shape): BoardShapeSummary[] => {
      if (!isRecord(shape)) return [];
      const s = shape;
      if (typeof s.id !== "string" || typeof s.type !== "string") return [];
      if (![s.x, s.y, s.w, s.h].every(finite)) return [];
      const str = (key: string, max: number) =>
        typeof s[key] === "string" ? { [key]: (s[key] as string).slice(0, max) } : {};
      const picture =
        typeof s.picture === "number" &&
        Number.isInteger(s.picture) &&
        s.picture >= 1 &&
        s.picture <= BOARD_ASSIST_INPUT_LIMITS.images
          ? { picture: s.picture }
          : {};
      return [
        {
          id: s.id.slice(0, 80),
          type: s.type.slice(0, 40),
          x: s.x as number,
          y: s.y as number,
          w: s.w as number,
          h: s.h as number,
          ...str("text", 500),
          ...str("color", 20),
          ...str("frame", 80),
          ...str("from", 80),
          ...str("to", 80),
          ...picture,
        } as BoardShapeSummary,
      ];
    });

  const view = area(raw.view);
  const pin = readPin(raw.pin);
  const capabilities = readCapabilities(raw.capabilities);
  const theme = raw.theme === "light" || raw.theme === "dark" ? raw.theme : undefined;
  const tierOverride = readTierOverride(raw.tierOverride);
  const issues = readIssues(raw.issues);
  const history = readHistory(raw.history);
  const attachments = readAttachments(raw.attachments);
  const images = readImages(raw.images);
  const correction = readCorrection(raw.correction);
  const thread = Array.isArray(raw.thread)
    ? raw.thread.slice(-8).flatMap((message) => {
        if (!isRecord(message)) return [];
        return typeof message.text === "string" &&
          (message.from === "person" || message.from === "moss")
          ? [{ from: message.from as "person" | "moss", text: message.text.slice(0, 600) }]
          : [];
      })
    : [];
  const answers = Array.isArray(raw.answers)
    ? raw.answers.slice(0, 3).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        return typeof entry.q === "string" && typeof entry.answer === "string"
          ? [{ q: entry.q.slice(0, 200), answer: entry.answer.slice(0, 600) }]
          : [];
      })
    : [];
  const selected = Array.isArray(raw.selected)
    ? raw.selected.filter((id): id is string => typeof id === "string").slice(0, 50)
    : [];

  return {
    board: {
      shapes,
      truncated:
        Boolean((board as { truncated?: unknown } | null)?.truncated) ||
        (Array.isArray(shapesRaw) && shapesRaw.length > 400),
    },
    ask: {
      text: raw.text,
      via: raw.via,
      ...(pin ? { pin } : {}),
      ...(view && view.w !== undefined && view.h !== undefined ? { view: view as never } : {}),
      ...(thread.length > 0 ? { thread } : {}),
      ...(answers.length > 0 ? { answers } : {}),
      ...(selected.length > 0 ? { selected } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(theme ? { theme } : {}),
      ...(tierOverride ? { tierOverride } : {}),
      ...(issues.length > 0 ? { issues } : {}),
      ...(history.length > 0 ? { history } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(correction ? { correction } : {}),
    },
    ...(expectedBoard !== undefined ? { expectedBoard } : {}),
  };
}

/** Streams one board ask. Errors become a final `error` event so the SSE client can show a plain message. */
export async function* streamBoardAssist(
  gateway: PageAppAiGateway,
  input: Pick<BoardAssistRequestInput, "board" | "ask">,
  signal: AbortSignal,
): AsyncGenerator<BoardAssistEvent> {
  if (running >= MAX_RUNNING) {
    yield { type: "error", code: "resource_exhausted", message: "板上 Moss 正忙，请稍后再试。" };
    return;
  }
  running += 1;
  try {
    const prompt = buildBoardAssistPrompt(input.board, input.ask);
    yield { type: "start", tier: prompt.tier };
    for await (const event of gateway.ask(
      {
        input: prompt.input,
        system: prompt.system,
        tier: prompt.tier,
        maxTokens: prompt.maxTokens,
        ...(input.ask.images?.length
          ? {
              images: input.ask.images.map(({ mimeType, dataBase64 }) => ({
                mimeType,
                dataBase64,
              })),
            }
          : {}),
      },
      signal,
    )) {
      if (event.type === "text") yield { type: "text", delta: event.delta };
      else if (event.type === "done") yield { type: "done", model: event.model ?? "" };
    }
  } catch (cause) {
    const error =
      cause instanceof PageAppCapabilityError
        ? { code: cause.code, message: BOARD_ASSIST_MESSAGES[cause.code] ?? cause.message }
        : { code: "upstream_error", message: BOARD_ASSIST_MESSAGES.upstream_error! };
    yield { type: "error", ...error };
  } finally {
    running -= 1;
  }
}

/** "<instanceId>:<provider>:<model>" from settings, or null for "auto". */
export function parseBoardAssistModel(value: string | undefined): ModelSelection | null {
  if (!value || value === "auto") return null;
  const [instanceId, provider, ...rest] = value.split(":");
  const model = rest.join(":");
  if (!instanceId || !provider || !model) return null;
  return { provider, instanceId, model } as ModelSelection;
}

/** Optional one-off CLI runner adapter when no Moss gateway session is configured. */
export async function* streamBoardAssistViaCli(
  input: Pick<BoardAssistRequestInput, "board" | "ask">,
  selection: ModelSelection,
  run: (prompt: string) => Promise<{ readonly lines: string }>,
): AsyncGenerator<BoardAssistEvent> {
  if (running >= MAX_RUNNING) {
    yield { type: "error", code: "resource_exhausted", message: "板上 Moss 正忙，请稍后再试。" };
    return;
  }
  running += 1;
  try {
    const prompt = buildBoardAssistPrompt(input.board, input.ask);
    yield { type: "start", tier: "cli" };
    const { lines } = await run(`${prompt.system}\n\n${prompt.input}`);
    yield { type: "text", delta: `${lines.trim()}\n` };
    yield { type: "done", model: `${selection.provider}/${selection.model}` };
  } catch (cause) {
    const detail =
      typeof cause === "object" && cause !== null && "detail" in cause
        ? String((cause as { detail: unknown }).detail)
        : cause instanceof Error
          ? cause.message
          : String(cause);
    yield { type: "error", code: "cli_failed", message: `CLI 没有完成：${detail.slice(0, 300)}` };
  } finally {
    running -= 1;
  }
}

const MODELS_TTL_MS = 5 * 60_000;
const modelCache = new Map<string, { at: number; models: Promise<ReadonlyArray<string>> }>();

/** The account's model list, cached briefly per access token; failed loads are evicted. */
export function cachedBoardAssistModels(
  accessToken: string,
  load: () => Promise<ReadonlyArray<string>>,
): Promise<ReadonlyArray<string>> {
  const hit = modelCache.get(accessToken);
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models;
  const models = load();
  modelCache.set(accessToken, { at: Date.now(), models });
  models.catch(() => modelCache.delete(accessToken));
  for (const [key, entry] of modelCache) {
    if (Date.now() - entry.at >= MODELS_TTL_MS) modelCache.delete(key);
  }
  return models;
}

const CREDENTIAL_TTL_MS = 60_000;
let credentialCache: { at: number; value: unknown } | null = null;

/** Cache the resolved gateway credential briefly so repeated board asks don't re-resolve auth. */
export function cachedBoardAssistCredential<A, E, R>(
  resolve: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    if (credentialCache && Date.now() - credentialCache.at < CREDENTIAL_TTL_MS) {
      return Effect.succeed(credentialCache.value as A);
    }
    return resolve.pipe(
      Effect.tap((value) => Effect.sync(() => (credentialCache = { at: Date.now(), value }))),
    );
  });
}

export function resetBoardAssistCachesForTests(): void {
  credentialCache = null;
  modelCache.clear();
}

/** Tier-aware preferred models across CN and Global gateways; never overrides default/complex with a tiny flash model. */
export const BOARD_ASSIST_TIER_MODELS: Record<BoardAssistTier, ReadonlyArray<string>> = {
  quick: [
    "glm-5.3-flash",
    "deepseek-v4-flash",
    "gpt-5.6-mini",
    "gpt-5-mini",
    "gemini-2.5-flash",
    "claude-haiku-4-5",
  ],
  default: [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "gpt-5.6",
    "gpt-5.2",
    "kimi-k3",
    "glm-5.3",
  ],
  complex: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "gpt-5.6-terra",
    "deepseek-v4-pro",
    "qwen3.8-max",
    "deepseek-reasoner",
  ],
};

/** Fastest models for quick whiteboard edits (retained for compatibility). */
export const BOARD_ASSIST_FAST_MODELS: ReadonlyArray<string> = BOARD_ASSIST_TIER_MODELS.quick;
