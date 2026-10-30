import { Effect } from "effect";

import {
  COMPUTER_HISTORY_MAX_QUERY_RESULTS,
  type ComputerHistoryListHistoryInput,
} from "@synara/contracts";

import type { ComputerHistoryService } from "../computerHistory/service.ts";
import { projectComputerHistoryEntryForModel } from "../computerHistory/summaryProjection.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError } from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

const COMPUTER_HISTORY_STATUS_RECEIPT_TTL_MS = 2 * 60 * 1000;
const COMPUTER_HISTORY_STATUS_RECEIPT_MAX = 512;

interface HistoryStatusReceipt {
  readonly expiresAt: number;
}

function readHistoryCallerKey(context: {
  readonly callerSessionKey: string;
  readonly callerTurnId: string | null;
}): string {
  const sessionKey = context.callerSessionKey.trim();
  const turnId = context.callerTurnId?.trim() ?? "";
  if (sessionKey.length === 0 || turnId.length === 0) {
    throw new Error(
      "Computer History tools require an explicit active user turn and provider session.",
    );
  }
  // Session and turn are both part of the authority boundary. Do not widen
  // this to a thread/provider key: a receipt must never cross turns.
  return `${sessionKey}\u0000${turnId}`;
}

async function assertHistoryCallerTurnActive(context: {
  readonly callerSessionKey: string;
  readonly callerTurnId: string | null;
  readonly assertCallerTurnActive: () => Effect.Effect<void, unknown>;
}): Promise<void> {
  readHistoryCallerKey(context);
  await Effect.runPromise(context.assertCallerTurnActive());
}

function readOptionalNonNegativeInt(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-negative integer.`);
  }
  return Number(value);
}

export function makeAgentGatewayComputerHistoryTools(input: {
  readonly service: ComputerHistoryService;
  /** Injectable only for deterministic focused tests; production uses Date.now. */
  readonly now?: () => number;
}): ReadonlyArray<ToolEntry> {
  const now = input.now ?? Date.now;
  const statusReceipts = new Map<string, HistoryStatusReceipt>();

  const purgeExpiredStatusReceipts = (at: number = now()) => {
    for (const [key, receipt] of statusReceipts) {
      if (receipt.expiresAt <= at) statusReceipts.delete(key);
    }
  };
  const invalidateStatusReceipt = (key: string) => {
    statusReceipts.delete(key);
  };
  const hasPositiveStatusReceipt = (key: string): boolean => {
    const at = now();
    purgeExpiredStatusReceipts(at);
    const receipt = statusReceipts.get(key);
    if (receipt === undefined || receipt.expiresAt <= at) {
      statusReceipts.delete(key);
      return false;
    }
    // Keep active callers warm in the bounded map while retaining the fixed
    // short TTL. This is an LRU touch, not a TTL extension.
    statusReceipts.delete(key);
    statusReceipts.set(key, receipt);
    return true;
  };
  const rememberPositiveStatusReceipt = (key: string) => {
    const at = now();
    purgeExpiredStatusReceipts(at);
    while (statusReceipts.size >= COMPUTER_HISTORY_STATUS_RECEIPT_MAX) {
      const oldest = statusReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      statusReceipts.delete(oldest);
    }
    statusReceipts.set(key, { expiresAt: at + COMPUTER_HISTORY_STATUS_RECEIPT_TTL_MS });
  };

  const historyStatus: ToolEntry = {
    requiredCapability: "history:status",
    requiresActiveTurn: true,
    definition: {
      name: "history_status",
      description:
        "Read the local Computer History recorder status. This is metadata only; it never returns captured text or raw event payloads.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Computer History status", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) => {
      if (!context.callerCapabilities.has("history:status")) {
        return Effect.succeed(
          mcpToolResultError("This provider session is not authorized for history:status."),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          await assertHistoryCallerTurnActive(context);
          const callerKey = readHistoryCallerKey(context);
          // A new status call is authoritative for this exact turn. If it
          // fails or reports disabled, an older receipt must not survive.
          invalidateStatusReceipt(callerKey);
          const state = await input.service.getState();
          await input.service.recordAccessAudit({
            tool: "history_status",
            callerThreadId: context.callerThreadId,
            callerProvider: context.callerProvider,
          });
          if (state.supported && state.enabled) {
            rememberPositiveStatusReceipt(callerKey);
          }
          return mcpToolResultJson({
            supported: state.supported,
            enabled: state.enabled,
            recorder_state: state.recorderState,
            activation_state: state.activationState,
            permissions: {
              input_monitoring: state.inputMonitoringPermission,
              accessibility: state.accessibilityPermission,
              screen_recording: state.screenRecordingPermission,
            },
            private_browsing_excluded: state.privateBrowsingExcluded,
            browser_capabilities: state.browserCapabilities,
            capture_capability: {
              mode: state.captureCapability.mode,
              interaction_events: state.captureCapability.interactionEvents,
              activity_summaries: state.captureCapability.activitySummaries,
              detail: state.captureCapability.detail,
            },
            health: state.health,
            model_context_disclosure: {
              included: false,
              not_implicitly_injected: true,
              text: "Status is metadata only. No captured observations were added to model context.",
            },
            access_audit_recorded: true,
          });
        },
        catch: (error) => error,
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(String(error)))));
    },
  };

  const historyQuery: ToolEntry = {
    requiredCapability: "history:query",
    requiresActiveTurn: true,
    definition: {
      name: "history_query",
      description:
        "Query sensitive local Computer History as summarized entries only. Use a narrow time window and prefer a limit of 20 or fewer; the hard maximum is 200. Raw keyboard/mouse/accessibility payloads are never returned.",
      inputSchema: {
        type: "object",
        properties: {
          sinceMs: { type: "integer", minimum: 0 },
          untilMs: { type: "integer", minimum: 0 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: COMPUTER_HISTORY_MAX_QUERY_RESULTS,
            description: "Defaults to 20; prefer 20 or fewer unless the user asks for more.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "Query Computer History", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) => {
      if (!context.callerCapabilities.has("history:query")) {
        return Effect.succeed(
          mcpToolResultError("This provider session is not authorized for history:query."),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          await assertHistoryCallerTurnActive(context);
          const callerKey = readHistoryCallerKey(context);
          if (!hasPositiveStatusReceipt(callerKey)) {
            throw new Error(
              "history_query requires a successful history_status call in this same active turn; call history_status first.",
            );
          }
          const limit = readOptionalNonNegativeInt(args, "limit");
          if (limit !== undefined && (limit < 1 || limit > COMPUTER_HISTORY_MAX_QUERY_RESULTS)) {
            throw new ToolInputError(
              `Argument "limit" must be between 1 and ${COMPUTER_HISTORY_MAX_QUERY_RESULTS}.`,
            );
          }
          const sinceMs = readOptionalNonNegativeInt(args, "sinceMs");
          const untilMs = readOptionalNonNegativeInt(args, "untilMs");
          const query: ComputerHistoryListHistoryInput = {
            ...(sinceMs === undefined ? {} : { sinceMs }),
            ...(untilMs === undefined ? {} : { untilMs }),
            // Keep ordinary model consultations narrow by default. Callers
            // may still request the bounded 200-entry maximum explicitly.
            limit: limit ?? 20,
          };
          const state = await input.service.getState();
          if (!state.supported || !state.enabled) {
            invalidateStatusReceipt(callerKey);
            throw new Error(
              "history_query was rejected because Computer History is no longer supported and enabled in this active turn.",
            );
          }
          if (!hasPositiveStatusReceipt(callerKey)) {
            throw new Error(
              "history_query status authorization expired; call history_status again in this active turn.",
            );
          }
          const result = await input.service.listHistory(query);
          await input.service.recordAccessAudit({
            tool: "history_query",
            callerThreadId: context.callerThreadId,
            callerProvider: context.callerProvider,
            resultCount: result.entries.length,
          });
          return mcpToolResultJson({
            // Never spread the desktop/UI result into model context. It may
            // contain bounded icon data and the local memory resource path;
            // the explicit projection also removes local path/icon metadata.
            entries: result.entries.map(projectComputerHistoryEntryForModel),
            next_cursor: result.nextCursor,
            model_context_disclosure: {
              included: true,
              not_implicitly_injected: true,
              text: "The summarized entries in this history_query result are included in this tool call's model context; history is not implicitly injected into unrelated turns.",
            },
            access_audit_recorded: true,
          });
        },
        catch: (error) => error,
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(String(error)))));
    },
  };

  return [historyStatus, historyQuery];
}
