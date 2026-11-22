// FILE: boardAssist.ts
// Purpose: Server half of 板上 Moss: validates a board ask, builds the shared prompt, and
//          streams model lines (JSONL ops + final reply) through Moss's AI gateway.
// Layer: Server. One memoryless streamed completion per ask, using zero sync filesystem calls.

import type { ModelSelection } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";
import { buildBoardAssistPrompt, type BoardAssistAsk } from "@moss/shared/spaceItems/boardAssist";
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
  authentication_required: "登录 Moss 账号后，板上 Moss 才能直接修改白板。",
  quota_exceeded: "Moss 额度用完了，充值后再试。",
  resource_exhausted: "模型正忙，请稍后再试。",
  unavailable: "板上 Moss 暂时连不上模型，请稍后再试。",
  upstream_error: "板上 Moss 暂时连不上模型，请稍后再试。",
};

let running = 0;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function area(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const box = value as Record<string, unknown>;
  if (!finite(box.x) || !finite(box.y)) return undefined;
  return {
    x: box.x,
    y: box.y,
    ...(finite(box.w) ? { w: box.w } : {}),
    ...(finite(box.h) ? { h: box.h } : {}),
  };
}

export interface BoardAssistRequestInput {
  readonly board: { readonly shapes: BoardShapeSummary[]; readonly truncated: boolean };
  readonly ask: BoardAssistAsk;
  readonly expectedBoard?: unknown;
}

/** Accepts only the fields the prompt uses; unrelated fields are dropped before prompting. */
export function readBoardAssistBody(body: unknown): BoardAssistRequestInput | null {
  if (typeof body !== "object" || body === null) return null;
  const { board, ask, expectedBoard } = body as {
    board?: unknown;
    ask?: unknown;
    expectedBoard?: unknown;
  };
  if (typeof ask !== "object" || ask === null) return null;
  const raw = ask as Record<string, unknown>;
  if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 4_000) return null;
  if (raw.via !== "comment" && raw.via !== "composer") return null;

  const shapesRaw = (board as { shapes?: unknown } | null)?.shapes;
  const shapes = (Array.isArray(shapesRaw) ? shapesRaw : [])
    .slice(0, 400)
    .flatMap((shape): BoardShapeSummary[] => {
      const s = shape as Record<string, unknown>;
      if (typeof s?.id !== "string" || typeof s.type !== "string") return [];
      if (![s.x, s.y, s.w, s.h].every(finite)) return [];
      const str = (key: string, max: number) =>
        typeof s[key] === "string" ? { [key]: (s[key] as string).slice(0, max) } : {};
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
        } as BoardShapeSummary,
      ];
    });

  const view = area(raw.view);
  const pin = area(raw.pin);
  const thread = Array.isArray(raw.thread)
    ? raw.thread.slice(-8).flatMap((message) => {
        const m = message as Record<string, unknown>;
        return typeof m?.text === "string" && (m.from === "person" || m.from === "moss")
          ? [{ from: m.from as "person" | "moss", text: m.text.slice(0, 600) }]
          : [];
      })
    : [];
  const answers = Array.isArray(raw.answers)
    ? raw.answers.slice(0, 3).flatMap((entry) => {
        const a = entry as Record<string, unknown>;
        return typeof a?.q === "string" && typeof a.answer === "string"
          ? [{ q: a.q.slice(0, 200), answer: a.answer.slice(0, 600) }]
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

/** Fastest CN-gateway models for first-line whiteboard edits. */
export const BOARD_ASSIST_FAST_MODELS: ReadonlyArray<string> = [
  "kimi-k3",
  "glm-5.3",
  "glm-5.3-flash",
];
