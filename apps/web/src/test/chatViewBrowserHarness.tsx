// FILE: chatViewBrowserHarness.tsx
// Purpose: The full-app fixture shared by the ChatView browser files (ChatView.*.browser.tsx):
//          the mock server, snapshots, mounting and the suite hooks. Each file declares the
//          module mocks itself (chatViewBrowserMocks.ts holds their shared state).

import { resetThreadDetailResumeCursors } from "../threadDetailResumeCursors";
import { resetEmbeddedBundleChecks } from "~/lib/embeddedBundleCheck";
import { getCentralIconUrl } from "~/lib/central-icons";
import { centralIconNameOf } from "~/lib/icons";
import { spaceKindMeta } from "../components/space/spaceKinds";
import "../index.css";
import {
  AutomationId,
  type AutomationCreateInput,
  type AutomationDefinition,
  CheckpointRef,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  DEVICE_WS_METHODS,
  COMPUTER_WS_METHODS,
  GUEST_SHARE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  type NativeApi,
  type MossCloudAccountState,
  type MossNormalizedSessionEvent,
  type OrchestrationReadModel,
  type ProjectId,
  type ProviderSession,
  ProviderGetComposerCapabilitiesInput,
  type ProviderComposerCapabilities,
  type ProviderSubmitPermissionActionInput,
  type ProviderSubmitPermissionActionResult,
  type RealtimeVoiceEvent,
  type RealtimeVoiceState,
  RuntimeSessionId,
  type ServerConfig,
  type ServerProviderUsageSnapshot,
  type ServerSettings,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_METHODS,
  WsRpcError,
  OrchestrationSessionStatus,
} from "@moss/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@moss/shared/binaryTransfer";
import { LOCAL_IMAGE_ROUTE_PATH } from "@moss/shared/localPreviewFiles";
import { MOSS_CODEX_RESPONSES_MODEL_IDS } from "@moss/shared/mossManagedModelCatalog";
import { resolveProviderInstance } from "@moss/shared/providerInstances";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Schema } from "effect";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { commands, page } from "vitest/browser";
import React, { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import { composerPredictionStore } from "../lib/composerPrediction";
import { getScrollContainerDistanceFromBottom } from "../chat-scroll";
import { resetThemeSnapshotCacheForTests } from "../hooks/useTheme";
import { useLatestProjectStore } from "../latestProjectStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { isMacNavigatorPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { resetHomeChatProjectPrewarmStateForTests } from "../lib/chatProjects";
import { getRouter } from "../router";
import { useRightDockStore } from "../rightDockStore";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { clearThreadDetailCache } from "../lib/threadDetailCache";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
  sendEffectRpcFailure,
} from "../test/effectRpcWebSocketMock";
import {
  unconfiguredMossCloudAccountState,
  unconfiguredMossEnterpriseKeyState,
  unconfiguredMossPhoneAccountState,
} from "../test/mossAccountStateFixtures";
import {
  acknowledgeStartupAnnouncementsForTest,
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
  createFullscreenTestHost,
} from "../test/browserHarness";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resetWsNativeApiForTest } from "../wsNativeApi";
import { useThreadDispatchStore } from "../components/chat/useChatLocalDispatch";
import { MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT } from "../components/chat/mossLoopLedgerDashboard";
import "../components/ChatView";
import { realtimeVoiceChatHarness } from "./chatViewBrowserMocks";
// Production CSS is part of the behavior under test because row height depends on it.

// Pre-transform the compiler-heavy component outside the first case's timeout.
// The router's auto-split route otherwise requests this module on first mount.

export const THREAD_ID = "thread-browser-test" as ThreadId;
export const OTHER_THREAD_ID = "thread-browser-test-other" as ThreadId;

// Each call to the snapshot factory gets a fresh, monotonically increasing sequence.
// The step (1_000_000) is far larger than any single test can bridge: in-test
// increments come only from `recordProjectCreateCommand`, `addThreadToSnapshot`, and
// the per-test snapshot-sync helpers, each +1 per call and bounded by waitFor-driven
// helper invocations (hundreds at most). So a late in-flight shell snapshot from a
// previous test is always strictly below the next test's base sequence and is ignored
// by `isStaleSnapshot`.
export let snapshotSequenceFactory = 0;
export function nextSnapshotSequence(): number {
  snapshotSequenceFactory += 1_000_000;
  return snapshotSequenceFactory;
}
export const THREAD_TITLE = "Browser test thread";
export const REALTIME_VOICE_SESSION_ID = "voice-chat-shell-browser-session";
export const REALTIME_VOICE_CLAIM_ID = "voice-chat-shell-browser-claim";
export const MOSS_SEQUENCE_SESSION_ID = RuntimeSessionId.makeUnsafe(
  "runtime-session-moss-visible-sequence",
);
export const MOSS_SEQUENCE_SECONDARY_SESSION_ID = RuntimeSessionId.makeUnsafe(
  "runtime-session-moss-visible-sequence-secondary",
);

// Moss defaults the UI to zh-CN, but this suite asserts upstream's English copy. Tests
// (and the app) overwrite the settings blob wholesale, so merge the override into every
// write instead of seeding it once.
export const nativeLocalStorageSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
  let nextValue = value;
  if (key === "moss:app-settings:v1") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        nextValue = JSON.stringify({ localeOverride: "en", ...parsed });
      }
    } catch {
      // Non-JSON writes pass through untouched.
    }
  }
  nativeLocalStorageSetItem.call(this, key, nextValue);
};
export const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROJECT_ID = "project-1" as ProjectId;
export const OTHER_PROJECT_ID = "project-2" as ProjectId;
export const HOME_PROJECT_ID = "project-home" as ProjectId;
export const STUDIO_PROJECT_ID = "project-studio" as ProjectId;
export const STUDIO_DRAFT_THREAD_ID = "thread-studio-draft" as ThreadId;
export const NOW_ISO = "2026-03-04T12:00:00.000Z";
export const BASE_TIME_MS = Date.parse(NOW_ISO);
export const ATTACHMENT_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
export const UI_PARITY_RECEIPT_ROOT = "../../../../.tmp/ui-parity";
export const GENERATED_IMAGE_PREVIEW_RECEIPT_DIR = UI_PARITY_RECEIPT_ROOT;
export const GENERATED_IMAGE_PREVIEW_B21_RECEIPT_DIR = `${UI_PARITY_RECEIPT_ROOT}/HEL-46-generated-image-preview-b21`;
export const GENERATED_IMAGE_PREVIEW_B22_RECEIPT_DIR = `${UI_PARITY_RECEIPT_ROOT}/HEL-46-generated-image-preview-b22`;
export const IMAGE_GENERATION_LIMIT_RECEIPT_DIR = `${UI_PARITY_RECEIPT_ROOT}/HEL-46-image-gen-limit-b32`;
export const APP_SETTINGS_STORAGE_KEY = "moss:app-settings:v1";
export let attachmentResponseDelayMs = 0;
export let attachmentUploadSequence = 0;
export let attachmentUploadBarrier: Promise<void> | null = null;
export let attachmentCancelBarrier: Promise<void> | null = null;
export const localImageDownloadRequests: string[] = [];

export const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

export const INACTIVE_REALTIME_VOICE_STATE: RealtimeVoiceState = {
  phase: "inactive",
  sessionId: null,
  threadId: null,
  ownerClaimId: null,
  source: null,
  voice: null,
  requestedModel: null,
  actualModel: null,
  activity: null,
  barrier: {
    requestAccepted: false,
    backendStarted: false,
    webRtcConnected: false,
    dataSessionInitialized: false,
  },
  inputMuted: false,
  outputMuted: false,
  error: null,
};

export const ACTIVE_REALTIME_VOICE_STATE: RealtimeVoiceState = {
  phase: "active",
  sessionId: REALTIME_VOICE_SESSION_ID,
  threadId: THREAD_ID,
  ownerClaimId: REALTIME_VOICE_CLAIM_ID,
  source: "composer-existing",
  voice: "maple",
  requestedModel: "gpt-realtime-2.1",
  actualModel: "gpt-realtime-2.1",
  activity: "listening",
  barrier: {
    requestAccepted: true,
    backendStarted: true,
    webRtcConnected: true,
    dataSessionInitialized: true,
  },
  inputMuted: false,
  outputMuted: false,
  error: null,
};

export function installRealtimeVoiceChatNativeApi(
  initialState: RealtimeVoiceState = INACTIVE_REALTIME_VOICE_STATE,
) {
  const baseNativeApi = readNativeApi();
  if (!baseNativeApi) {
    throw new Error("Expected browser native API before installing Realtime Voice test stub.");
  }
  const previousNativeApi = window.nativeApi;
  let eventListener: ((event: RealtimeVoiceEvent) => void) | null = null;

  const getState = vi.fn(async () => initialState);
  const listVoices = vi.fn(async () => ({
    defaultVoice: "maple" as const,
    preferredTransport: "webrtc" as const,
    voices: [
      {
        id: "maple" as const,
        displayName: "Maple",
        description: "Warm and clear",
      },
    ],
  }));
  const claim = vi.fn(async () => ({
    ownerClaimId: REALTIME_VOICE_CLAIM_ID,
    expiresAt: Date.now() + 30_000,
    preferredTransport: "webrtc" as const,
  }));
  const start = vi.fn(async () => ({
    sessionId: REALTIME_VOICE_SESSION_ID,
    transport: { type: "webrtc" as const, sdp: "moss-chat-shell-browser-answer" },
    requestedModel: "gpt-realtime-2.1",
  }));
  const reportClientState = vi.fn(async () => ACTIVE_REALTIME_VOICE_STATE);
  const appendText = vi.fn(async () => ({ accepted: true }));
  const appendSpeech = vi.fn(async () => ({ accepted: true }));
  const stop = vi.fn(async () => ({ accepted: true }));
  const releaseClaim = vi.fn(async () => ({ accepted: true }));
  const resolveScreenContext = vi.fn(async () => ({ accepted: true }));
  const unsubscribe = vi.fn();
  const onEvent = vi.fn((listener: (event: RealtimeVoiceEvent) => void) => {
    eventListener = listener;
    return unsubscribe;
  });
  const editKeybindings = vi.fn(
    async () => ({ keybindings: [], issues: { warnings: [], errors: [] } }) as never,
  );

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    writable: true,
    value: {
      ...baseNativeApi,
      realtimeVoice: {
        getState,
        listVoices,
        claim,
        start,
        reportClientState,
        appendText,
        appendSpeech,
        stop,
        releaseClaim,
        resolveScreenContext,
        onEvent,
        editKeybindings,
      },
    } satisfies NativeApi,
  });

  return {
    appendText,
    claim,
    getState,
    listVoices,
    onEvent,
    reportClientState,
    start,
    stop,
    unsubscribe,
    emit(event: RealtimeVoiceEvent) {
      eventListener?.(event);
    },
    restore() {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          writable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
    },
  };
}

export interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

export interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  serverSettings: ServerSettings;
  providerUsageSnapshot: ServerProviderUsageSnapshot | null;
  providerStatusesSnapshot: ServerConfig["providers"] | null;
  welcome: WsWelcomePayload;
  gitBranchByCwd: Record<string, string>;
  // Opt-in working tree for the diff panel: a cwd listed here answers its diff reads.
  workingTreePatchByCwd: Record<string, string>;
  projectAgentOverviews: Record<string, unknown>;
}

export let fixture: TestFixture;
// The open domain-event stream, so a case can append an activity the way the server does.
export let domainEventStream: {
  client: Parameters<typeof sendEffectRpcChunk>[0];
  requestId: string;
} | null = null;
export let threadDetailSnapshotBarrier: Promise<void> | null = null;
export const threadDetailSnapshotBarrierById = new Map<ThreadId, Promise<void>>();
export const wsRequests: WsRequestEnvelope["body"][] = [];
// Per-test override for the Moss cloud account read (the default is signed out). The
// rail's Images destination gates on it, so the gate test flips this before mounting.
export let mossCloudAccountStateOverride: MossCloudAccountState | null = null;
// Per-test composer prediction. By default the model has nothing to suggest.
export let composerPredictionSuggestion: string | null = null;
export const wsLink = ws.link(/ws(s)?:\/\/.*/);

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
};
export const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024 },
  { name: "mobile", width: 430, height: 932 },
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];
export const ATTACHMENT_VIEWPORT_MATRIX = [
  { name: "narrow", width: 320, height: 700 },
] as const satisfies readonly ViewportSpec[];

export interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
}

export interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureLayout: () => Promise<ChatLayoutMeasurement>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

export interface ChatLayoutMeasurement {
  hostHeightPx: number;
  composerBottomPx: number;
  scrollClientHeightPx: number;
  scrollHeightPx: number;
  distanceFromBottomPx: number;
}

export function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

export function createBaseServerConfig(): ServerConfig {
  return createBrowserTestServerConfig(NOW_ISO);
}

export function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

export function createAssistantMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
}) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

export function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

export function createComposerImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "queued-image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 8;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified: BASE_TIME_MS,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

export function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  targetIndex?: number;
  messagePairCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < (options.messagePairCount ?? 22); index += 1) {
    const isTarget = index === (options.targetIndex ?? 3);
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: nextSnapshotSequence(),
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId:
            options.sessionStatus === "running"
              ? TurnId.makeUnsafe("turn-browser-fixture-active")
              : null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

export function createIssue550Snapshot(options: {
  messageCount: number;
  activityCount: number;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-issue-550" as MessageId,
    targetText: "issue 550 baseline",
  });
  const messages = Array.from({ length: options.messageCount }, (_, index) =>
    index % 2 === 0
      ? createUserMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-user-${index}`),
          text: `user message ${index}`,
          offsetSeconds: index * 2,
        })
      : createAssistantMessage({
          id: MessageId.makeUnsafe(`msg-issue-550-assistant-${index}`),
          text: `assistant message ${index}`,
          offsetSeconds: index * 2,
        }),
  );
  const activities = Array.from({ length: options.activityCount }, (_, index) => ({
    id: EventId.makeUnsafe(`activity-issue-550-${index}`),
    createdAt: isoAt(options.messageCount * 2 + index),
    kind: "tool.completed" as const,
    summary: `tool ${index}`,
    tone: "tool" as const,
    turnId: null,
    payload: {
      itemType: "dynamic_tool_call",
      toolName: `tool-${index}`,
    },
  }));

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, messages, activities } : thread,
    ),
  };
}

export function createSnapshotWithLongAssistantResponse(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-overflow-target" as MessageId,
    targetText: "start",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const messageIndex = messages.findIndex(
    (message, index) => message.role === "assistant" && index === 7,
  );
  if (messageIndex < 0) {
    return snapshot;
  }

  const message = messages[messageIndex]!;
  messages[messageIndex] = {
    ...message,
    text: Array.from(
      { length: 240 },
      (_, lineIndex) =>
        `${lineIndex + 1}. keep the viewport stable while this response keeps growing`,
    ).join("\n"),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

export function createSnapshotWithBottomAttachments(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-bottom-attachments" as MessageId,
    targetText: "bottom attachments",
  });

  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }

  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  if (lastUserMessageIndex < 0) {
    return snapshot;
  }

  const lastUserMessage = messages[lastUserMessageIndex]!;
  messages[lastUserMessageIndex] = {
    ...lastUserMessage,
    text: "final user message with delayed attachments",
    attachments: Array.from({ length: 3 }, (_, attachmentIndex) => ({
      type: "image" as const,
      id: `bottom-attachment-${attachmentIndex + 1}`,
      name: `bottom-attachment-${attachmentIndex + 1}.png`,
      mimeType: "image/png",
      sizeBytes: 128,
    })),
  };
  threads[threadIndex] = {
    ...thread,
    messages,
  };

  return {
    ...snapshot,
    threads,
  };
}

export function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    serverSettings: createBrowserTestServerSettings(NOW_ISO),
    providerUsageSnapshot: null,
    providerStatusesSnapshot: null,
    gitBranchByCwd: {},
    workingTreePatchByCwd: {},
    projectAgentOverviews: {},
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

export function findThreadDetailFromFixtureSnapshot(
  threadId: ThreadId,
): OrchestrationReadModel["threads"][number] | null {
  return fixture.snapshot.threads.find((entry) => entry.id === threadId) ?? null;
}

/** The rows of the open fallback context menu. */
export function contextMenuRows() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="context-menu-popup"] button'),
  );
}

export function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

export function createAutomationDefinitionFromCreateRequest(
  body: WsRequestEnvelope["body"],
): AutomationDefinition {
  const input = body as unknown as AutomationCreateInput;
  const definition: AutomationDefinition = {
    id: AutomationId.makeUnsafe(`automation-${wsRequests.length}`),
    projectId: input.projectId,
    sourceThreadId: input.sourceThreadId ?? null,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled ?? true,
    nextRunAt: null,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.interactionMode ?? "default",
    worktreeMode: input.worktreeMode ?? "auto",
    mode: input.mode ?? "standalone",
    targetThreadId: input.targetThreadId ?? null,
    maxIterations: input.maxIterations ?? null,
    stopAfterConsecutiveFailures:
      input.stopAfterConsecutiveFailures === undefined
        ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES
        : input.stopAfterConsecutiveFailures,
    consecutiveFailureCount: 0,
    disabledReason: null,
    disabledAt: null,
    completionPolicy: input.completionPolicy ?? { type: "none" },
    completionPolicyVersion: 1,
    completionPolicyUpdatedAt: NOW_ISO,
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
    maxRuntimeSeconds: input.maxRuntimeSeconds ?? 3_600,
    retryPolicy: input.retryPolicy ?? { type: "none" },
    misfirePolicy: input.misfirePolicy ?? "coalesce",
    acknowledgedRisks: input.acknowledgedRisks ?? [],
    iterationCount: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    archivedAt: null,
  };
  return input.providerOptions === undefined
    ? definition
    : { ...definition, providerOptions: input.providerOptions };
}

export function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

export function withSettledThreadBranch(
  snapshot: OrchestrationReadModel,
  branch: string,
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, branch, settledAt: NOW_ISO } : thread,
    ),
  };
}

export function withOpenProjectPickerFixtures(
  snapshot: OrchestrationReadModel,
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: OTHER_PROJECT_ID,
        kind: "project",
        title: "Other Project",
        workspaceRoot: "/repo/other",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

export function withHomeChatProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: HOME_PROJECT_ID,
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

export function withActiveHomeChatThread(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  const snapshotWithHomeProject = withHomeChatProject(snapshot);
  return {
    ...snapshotWithHomeProject,
    threads: snapshotWithHomeProject.threads.map((thread) =>
      thread.id === THREAD_ID ? { ...thread, projectId: HOME_PROJECT_ID } : thread,
    ),
  };
}

export function withStudioProject(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: STUDIO_PROJECT_ID,
        kind: "studio",
        title: "Studio",
        workspaceRoot: "/Users/tester/Documents/Moss/Studio",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
  };
}

export function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

export function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

export function createSnapshotWithActiveInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-plan-target" as MessageId,
    targetText: "inline plan thread",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.makeUnsafe("activity-inline-plan"),
                createdAt: isoAt(1_002),
                kind: "turn.tasks.updated",
                summary: "Tasks updated",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  tasks: [
                    {
                      task: "Inspecting ChatView boundaries",
                      status: "inProgress",
                    },
                    {
                      task: "Patch the shared checklist receiver",
                      status: "pending",
                    },
                    {
                      task: "Run final validation",
                      status: "completed",
                    },
                  ],
                },
              },
              {
                id: EventId.makeUnsafe("activity-inline-background-task"),
                createdAt: isoAt(1_003),
                kind: "task.started",
                summary: "Background agent started",
                tone: "info",
                turnId: activeTurnId,
                payload: {
                  taskId: "task-inline-background-agent",
                  taskType: "subagent",
                },
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId,
                  updatedAt: isoAt(1_003),
                }
              : null,
            updatedAt: isoAt(1_003),
          }
        : thread,
    ),
  };
}

export function createSnapshotWithTallComposerStack(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            checkpoints: [
              {
                turnId: activeTurnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.makeUnsafe("checkpoint-inline-plan"),
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    kind: "modified",
                    additions: 12,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.browser.tsx",
                    kind: "modified",
                    additions: 36,
                    deletions: 0,
                  },
                ],
                assistantMessageId: null,
                completedAt: isoAt(1_004),
              },
            ],
          }
        : thread,
    ),
  };
}

export function createSnapshotWithActiveFileChanges(): OrchestrationReadModel {
  const snapshot = createSnapshotWithTallComposerStack();
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => ({ ...thread, activities: [] })),
  };
}

export function createSnapshotWithSettledInlinePlan(): OrchestrationReadModel {
  const snapshot = createSnapshotWithActiveInlinePlan();
  const activeTurnId = TurnId.makeUnsafe("turn-inline-plan");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_004),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
            },
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-plan-complete"),
                role: "assistant",
                text: "Finished the investigation.",
                createdAt: isoAt(1_004),
                updatedAt: isoAt(1_004),
                completedAt: isoAt(1_004),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "ready",
                  activeTurnId: null,
                  updatedAt: isoAt(1_004),
                }
              : null,
            updatedAt: isoAt(1_004),
          }
        : thread,
    ),
  };
}

// A plan-mode thread whose latest turn has settled and that still has an
// actionable (unimplemented) proposed plan. This is exactly the state where the
// live composer shows the plan-follow-up prompt, so it's the setup that used to
// misroute an auto-dispatched queued *chat* turn into the plan-follow-up path.
export function createSnapshotWithSettledPlanAwaitingFollowUp(): OrchestrationReadModel {
  const snapshot = createSnapshotWithSettledInlinePlan();
  const planMarkdown = [
    "# Proposed plan",
    "",
    "- Step 1: capture the failing state",
    "- Step 2: apply the fix",
    "- Step 3: add regression coverage",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
            proposedPlans: [
              {
                id: "plan-awaiting-follow-up",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_005),
                updatedAt: isoAt(1_005),
              },
            ],
            updatedAt: isoAt(1_005),
          }
        : thread,
    ),
  };
}

export function createSnapshotWithInlineToolOverflow(options: {
  active: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-tools-target" as MessageId,
    targetText: "inline tools thread",
    sessionStatus: options.active ? "running" : "ready",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: activeTurnId,
              state: options.active ? "running" : "completed",
              requestedAt: isoAt(1_100),
              startedAt: isoAt(1_101),
              completedAt: options.active ? null : isoAt(1_108),
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-inline-tools"),
            },
            activities: Array.from({ length: 6 }, (_, index) => ({
              id: EventId.makeUnsafe(`activity-inline-tool-${index + 1}`),
              createdAt: isoAt(1_102 + index),
              kind: "tool.completed" as const,
              summary: `tool ${index + 1}`,
              tone: "tool" as const,
              turnId: activeTurnId,
              payload: {
                itemType: "dynamic_tool_call",
                toolName: `tool-${index + 1}`,
              },
            })),
            messages: [
              ...thread.messages,
              {
                turnId: activeTurnId,
                id: MessageId.makeUnsafe("msg-assistant-inline-tools"),
                role: "assistant",
                text: "Wrapped up the inline tool review.",
                createdAt: isoAt(1_109),
                updatedAt: isoAt(1_109),
                completedAt: options.active ? undefined : isoAt(1_109),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: options.active ? "running" : "ready",
                  activeTurnId: options.active ? activeTurnId : null,
                  updatedAt: options.active ? isoAt(1_107) : isoAt(1_108),
                }
              : null,
            updatedAt: options.active ? isoAt(1_107) : isoAt(1_109),
          }
        : thread,
    ),
  };
}

export function findInlineToolsTurnDisclosure(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-message-id='msg-assistant-inline-tools'] [data-turn-header='completed'] button[aria-expanded]",
  );
}

export function createSnapshotWithHistoricalToolHydrationDuringLiveTurn(options: {
  hydrateHistoricalActivities: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotWithInlineToolOverflow({ active: false });
  const liveTurnId = TurnId.makeUnsafe("turn-after-inline-tools");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId: liveTurnId,
              state: "running",
              requestedAt: isoAt(1_200),
              startedAt: isoAt(1_201),
              completedAt: null,
              assistantMessageId: MessageId.makeUnsafe("msg-assistant-live-after-history"),
            },
            activities: options.hydrateHistoricalActivities ? thread.activities : [],
            messages: [
              ...thread.messages,
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-user-live-after-history"),
                role: "user",
                text: "Keep working while history hydrates.",
                createdAt: isoAt(1_200),
                updatedAt: isoAt(1_200),
                streaming: false,
                source: "native",
              },
              {
                turnId: liveTurnId,
                id: MessageId.makeUnsafe("msg-assistant-live-after-history"),
                role: "assistant",
                text: "Current turn is still running.",
                createdAt: isoAt(1_202),
                updatedAt: isoAt(1_202),
                streaming: false,
                source: "native",
              },
            ],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "running",
                  activeTurnId: liveTurnId,
                  updatedAt: isoAt(1_202),
                }
              : null,
            updatedAt: isoAt(1_202),
          }
        : thread,
    ),
  };
}

export function recordProjectCreateCommand(command: unknown): boolean {
  if (
    !command ||
    typeof command !== "object" ||
    !("type" in command) ||
    command.type !== "project.create" ||
    !("projectId" in command) ||
    !("workspaceRoot" in command) ||
    !("title" in command)
  ) {
    return false;
  }

  const projectId = command.projectId as ProjectId;
  fixture = {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      snapshotSequence: fixture.snapshot.snapshotSequence + 1,
      projects: [
        ...fixture.snapshot.projects.filter((project) => project.id !== projectId),
        {
          id: projectId,
          kind:
            "kind" in command && (command.kind === "chat" || command.kind === "studio")
              ? command.kind
              : "project",
          title: String(command.title),
          workspaceRoot: String(command.workspaceRoot),
          defaultModelSelection:
            "defaultModelSelection" in command &&
            command.defaultModelSelection &&
            typeof command.defaultModelSelection === "object"
              ? (command.defaultModelSelection as OrchestrationReadModel["projects"][number]["defaultModelSelection"])
              : {
                  provider: "codex" as const,
                  model: "gpt-5",
                },
          scripts: [],
          createdAt:
            "createdAt" in command && typeof command.createdAt === "string"
              ? command.createdAt
              : NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      updatedAt: NOW_ISO,
    },
  };
  return true;
}

// The app-rail usage rings fall back to a per-provider live fetch while their
// batch read is unsettled. Neutral snapshots for the default rail providers
// (seeded into the query cache before first render and served over the wire)
// keep every surface on the batch contract.
export function createRailUsageFixtureSnapshots(): ServerProviderUsageSnapshot[] {
  return (["codex", "claudeAgent"] as const).map((provider) => ({
    provider,
    updatedAt: NOW_ISO,
    limits: [],
    usageLines: [],
    source: "browser.rail-usage-fixture",
    status: "ok",
  }));
}

export function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    if (recordProjectCreateCommand(body.command)) {
      return { sequence: fixture.snapshot.snapshotSequence };
    }
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.serverGenerateComposerPrediction) {
    // The model has nothing to suggest unless a test asks otherwise.
    return composerPredictionSuggestion === null
      ? { suggestion: null, outcome: "none" }
      : { suggestion: composerPredictionSuggestion, outcome: "suggested" };
  }
  if (tag === WS_METHODS.automationCreate) {
    return createAutomationDefinitionFromCreateRequest(body);
  }
  if (tag === WS_METHODS.serverGetSettings) {
    return fixture.serverSettings;
  }
  if (tag === WS_METHODS.serverUpdateSettings) {
    // Apply the patch like the real server would so useAppSettings' mutation
    // response keeps fixture-owned fields (managed provider instances, Moss
    // accounts) instead of resetting the cached settings to bare defaults.
    const { _tag: _ignoredTag, ...patch } = body;
    const patchRecord = patch as Record<string, unknown>;
    const current = fixture.serverSettings;
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patchRecord)) {
      if (key === "providers" && value !== null && typeof value === "object") {
        const nextProviders: Record<string, unknown> = { ...current.providers };
        for (const [provider, providerPatch] of Object.entries(value as Record<string, unknown>)) {
          const existing =
            current.providers[provider as keyof typeof current.providers] ?? undefined;
          nextProviders[provider] = {
            ...(existing as Record<string, unknown> | undefined),
            ...(providerPatch as Record<string, unknown>),
          };
        }
        next.providers = nextProviders;
        continue;
      }
      if (key === "providerInstances" && value !== null && typeof value === "object") {
        next.providerInstances = {
          ...current.providerInstances,
          ...(value as Record<string, unknown>),
        };
        continue;
      }
      next[key] = value;
    }
    fixture.serverSettings = next as unknown as ServerSettings;
    return fixture.serverSettings;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.serverMossCloudAccountState) {
    return mossCloudAccountStateOverride ?? unconfiguredMossCloudAccountState;
  }
  if (tag === WS_METHODS.serverMossAccountSession) {
    return unconfiguredMossPhoneAccountState;
  }
  // Answer every sign-in lane. Left to the `{}` fallback, the enterprise-key read fails
  // decoding and ends in error with no data; each later refetch then flips it back to
  // pending, and the account boundary reads that as an account change, so an automation
  // or image request in flight at that moment is refused.
  if (tag === WS_METHODS.serverMossEnterpriseKeyState) {
    return unconfiguredMossEnterpriseKeyState;
  }
  if (tag === WS_METHODS.profileGet) {
    return {
      scope: "local",
      realm: null,
      sync: "local",
      editable: true,
      profile: {
        displayName: "Moss",
        handle: null,
        avatar: { kind: "initials" },
        updatedAt: null,
      },
    };
  }
  if (tag === WS_METHODS.statsGetProfileStats) {
    return {
      generatedAt: "2026-09-02T00:00:00.000Z",
      timezone: { utcOffsetMinutes: 0, today: "2026-09-02" },
      identity: { homeDirBasename: "moss", initials: "MO", defaultHandle: "@moss" },
      activity: {
        currentStreakDays: 0,
        longestStreakDays: 0,
        totalPromptsSent: 0,
        totalThreads: 0,
        promptsToday: 0,
        longestTaskMs: null,
        heatmapMetric: "prompts",
        heatmap: [],
      },
      activeHours: { startHour: null, endHour: null, turnCount: 0, label: null },
      insights: {
        topProvider: null,
        topProviderPercent: null,
        topReasoning: null,
        topReasoningPercent: null,
        skillsExplored: 0,
        totalSkillsUsed: 0,
      },
      providerModels: [],
      skills: [],
      mostUsedSkill: null,
      mostWorkedProject: null,
      quota: {
        status: "unavailable",
        provider: null,
        window: null,
        usedPercent: null,
        resetsAt: null,
        planName: null,
      },
    };
  }
  if (tag === WS_METHODS.statsGetProfileTokenStats) {
    return {
      available: false,
      lifetimeTotalTokens: null,
      peakDayTokens: null,
      peakDay: null,
      providers: [],
      unavailableProviders: [],
      topProvider: null,
      topProviderPercent: null,
      models: [],
      heatmapMetric: "tokens",
      heatmap: [],
    };
  }
  if (tag === WS_METHODS.serverGetProviderUsageSnapshot) {
    return fixture.providerUsageSnapshot;
  }
  if (tag === WS_METHODS.serverListProviderUsage) {
    return createRailUsageFixtureSnapshots();
  }
  if (tag === WS_METHODS.providerListModels) {
    // Keep the full-app fixture contract-valid and neutral. Returning the
    // generic `{}` fallback makes real discovery retry malformed responses,
    // which leaks unrelated retry pressure across this file's many mounts.
    return { models: [], source: "unsupported", cached: false };
  }
  if (tag === WS_METHODS.providerGetComposerCapabilities) {
    const input = Schema.decodeUnknownSync(ProviderGetComposerCapabilitiesInput)(body);
    const { provider } = input;
    const instance = resolveProviderInstance(fixture.serverSettings, input);
    if (!instance || instance.driver !== provider) {
      throw new WsRpcError({
        message: `Unknown or mismatched provider instance for '${provider}'.`,
      });
    }
    const enabled = instance.enabled;
    // Mirror ProviderDiscoveryService's final response, including its unified
    // Moss skills catalog for every enabled provider, plus adapter capabilities.
    // A missing RPC reply ({}) makes discovery fail decoding and re-run on
    // every sidebar warm-up, adding unrelated work to transcript measurements.
    return {
      provider,
      supportsSkillMentions: enabled,
      supportsSkillDiscovery: enabled,
      supportsNativeSlashCommandDiscovery:
        enabled && ["claudeAgent", "droid", "opencode", "pi", "devin", "omp"].includes(provider),
      supportsPluginMentions: enabled && ["codex", "droid"].includes(provider),
      supportsPluginDiscovery: enabled && ["codex", "droid"].includes(provider),
      supportsRuntimeModelList: enabled,
      supportsThreadCompaction:
        enabled && ["codex", "grok", "opencode", "pi", "devin"].includes(provider),
      supportsThreadImport:
        enabled &&
        ["codex", "claudeAgent", "cursor", "droid", "opencode", "omp"].includes(provider),
    } satisfies ProviderComposerCapabilities;
  }
  if (tag === WS_METHODS.providerListAgents) {
    return { agents: [] };
  }
  if (tag === WS_METHODS.providerListSkills) {
    return { skills: [] };
  }
  if (tag === WS_METHODS.providerListCommands) {
    return { commands: [] };
  }
  if (tag === WS_METHODS.providerListPlugins) {
    return {
      marketplaces: [],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
    };
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  if (tag === WS_METHODS.pagesSpaces) {
    return { spaces: [] };
  }
  if (tag === WS_METHODS.pagesList) {
    return { pages: [] };
  }
  // The sidebar reads to-dos on Beta hosts; the `{}` fallback would fail to decode.
  if (tag === WS_METHODS.todoList) {
    return { todos: [] };
  }
  // The Code review badge shares the inbox list; keep its background read contract-valid.
  if (tag === WS_METHODS.githubInboxList) {
    return {
      viewer: null,
      items: [],
      errors: [],
      repositoryBatches: [],
      rateLimit: null,
      reviewRequestedCount: 0,
      reviewRequestedCountIncomplete: false,
    };
  }
  if (tag === WS_METHODS.gitListBranches) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: branchName,
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (
    (tag === WS_METHODS.gitReadWorkingTreeDiff || tag === WS_METHODS.gitWorkingTreeDiffStats) &&
    typeof body.cwd === "string" &&
    fixture.workingTreePatchByCwd[body.cwd] !== undefined
  ) {
    const patch = fixture.workingTreePatchByCwd[body.cwd]!;
    if (tag === WS_METHODS.gitReadWorkingTreeDiff) return { patch, truncated: false };
    const lines = patch.split("\n");
    return {
      additions: lines.filter((line) => /^\+(?!\+\+)/.test(line)).length,
      deletions: lines.filter((line) => /^-(?!--)/.test(line)).length,
      fileCount: lines.filter((line) => line.startsWith("diff --git ")).length,
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    const branchName = cwd ? (fixture.gitBranchByCwd[cwd] ?? "main") : "main";
    return {
      branch: branchName,
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    const requestedBranch =
      typeof body.newBranch === "string"
        ? body.newBranch
        : typeof body.branch === "string"
          ? body.branch
          : "main";
    return {
      worktree: {
        path: `/repo/.codex/worktrees/project/${requestedBranch.replaceAll("/", "-")}`,
        branch: requestedBranch,
      },
    };
  }
  if (tag === WS_METHODS.gitCreateDetachedWorktree) {
    return {
      worktree: {
        path: "/repo/.codex/worktrees/generated/moss",
        ref: "0123456789abcdef0123456789abcdef01234567",
        branch: typeof body.newBranch === "string" ? body.newBranch : null,
      },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.projectAgentListTasks) return { tasks: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListActivity) return { activity: [], nextCursor: null };
  if (tag === WS_METHODS.projectAgentListDocuments) return { documents: [] };
  if (tag === WS_METHODS.projectAgentListThreadIndex) return { threads: [] };
  // A fresh install: no assistants and no group chats yet (what opens the Mossbot onboarding).
  // An empty list shows the onboarding; a test that seeds an assistant keeps it (an unreadable list
  // leaves the applied overview in place, as before).
  if (tag === WS_METHODS.projectAgentListSummaries)
    return Object.keys(fixture.projectAgentOverviews).length === 0 ? { summaries: [] } : {};
  if (tag === WS_METHODS.mossbotRoomList) return [];
  if (tag === WS_METHODS.projectAgentGetOverview) {
    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    return fixture.projectAgentOverviews[projectId] ?? {};
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  if (
    tag === WS_METHODS.shellOpenInEditor ||
    tag === WS_METHODS.terminalWrite ||
    tag === WS_METHODS.terminalClose
  ) {
    return null;
  }
  return {};
}

export function installDeterministicSendNativeApi(options?: {
  rejectTurnStart?: boolean;
  /** The server's refusal text for a `thread.turn.resume`. */
  rejectResume?: string;
  beforeWorktreeCreation?: () => Promise<void>;
  beforeTurnStart?: () => Promise<void>;
  projectThreadCommands?: boolean;
}): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      git: {
        ...wsNativeApi.git,
        createDetachedWorktree: async (
          input: Parameters<typeof wsNativeApi.git.createDetachedWorktree>[0],
        ) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.gitCreateDetachedWorktree,
            ...input,
          };
          wsRequests.push(request);
          await options?.beforeWorktreeCreation?.();
          return resolveWsRpc(request) as Awaited<
            ReturnType<typeof wsNativeApi.git.createDetachedWorktree>
          >;
        },
      },
      terminal: {
        ...wsNativeApi.terminal,
        open: async (input: Parameters<typeof wsNativeApi.terminal.open>[0]) => {
          const request: WsRequestEnvelope["body"] = {
            _tag: WS_METHODS.terminalOpen,
            ...input,
          };
          wsRequests.push(request);
          return resolveWsRpc(request) as Awaited<ReturnType<typeof wsNativeApi.terminal.open>>;
        },
        write: async (input: Parameters<typeof wsNativeApi.terminal.write>[0]) => {
          wsRequests.push({
            _tag: WS_METHODS.terminalWrite,
            ...input,
          });
        },
      },
      orchestration: {
        ...wsNativeApi.orchestration,
        dispatchCommand: async (
          command: Parameters<typeof wsNativeApi.orchestration.dispatchCommand>[0],
        ) => {
          wsRequests.push({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            command,
          });
          if (command.type === "thread.turn.start") await options?.beforeTurnStart?.();
          if (options?.rejectTurnStart && command.type === "thread.turn.start") {
            throw new Error("Turn start failed for test.");
          }
          if (options?.rejectResume !== undefined && command.type === "thread.turn.resume") {
            throw new Error(options.rejectResume);
          }
          if (options?.projectThreadCommands && command.type === "thread.create") {
            const snapshot = addThreadToSnapshot(fixture.snapshot, command.threadId);
            fixture.snapshot = {
              ...snapshot,
              threads: snapshot.threads.map((thread) =>
                thread.id === command.threadId
                  ? { ...thread, ...command, id: command.threadId, session: null }
                  : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          if (options?.projectThreadCommands && command.type === "thread.meta.update") {
            const patch = Object.fromEntries(
              Object.entries(command).filter(([, value]) => value !== undefined),
            );
            fixture.snapshot = {
              ...fixture.snapshot,
              snapshotSequence: fixture.snapshot.snapshotSequence + 1,
              threads: fixture.snapshot.threads.map((thread) =>
                thread.id === command.threadId ? { ...thread, ...patch } : thread,
              ),
            };
            useStore.getState().syncServerReadModel(fixture.snapshot);
          }
          return { sequence: fixture.snapshot.snapshotSequence + 1 };
        },
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

export function toRecordedWsRequestBody(request: {
  readonly tag: string;
  readonly payload: unknown;
}): WsRequestEnvelope["body"] {
  if (request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return {
      _tag: request.tag,
      command: request.payload,
    };
  }
  return flattenEffectRpcRequestPayload(request.tag, request.payload);
}

export const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = toRecordedWsRequestBody(parsed.request);
      const method = requestBody._tag;
      wsRequests.push(requestBody);

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const threadId = requestBody.threadId as ThreadId;
        const thread = findThreadDetailFromFixtureSnapshot(threadId);
        if (!thread) {
          return;
        }
        const detailSnapshot = {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread,
          },
        };
        const sendDetailSnapshot = () =>
          sendEffectRpcChunk(client, parsed.request.id, detailSnapshot);
        const barrier =
          threadDetailSnapshotBarrierById.get(threadId) ?? threadDetailSnapshotBarrier;
        if (barrier) void barrier.then(sendDetailSnapshot);
        else sendDetailSnapshot();
        return;
      }
      if (method === WS_METHODS.subscribeOrchestrationDomainEvents) {
        domainEventStream = { client, requestId: parsed.request.id };
        return;
      }
      if (method === WS_METHODS.subscribeServerProviderStatuses) {
        if (fixture.providerStatusesSnapshot) {
          sendEffectRpcChunk(client, parsed.request.id, {
            providers: fixture.providerStatusesSnapshot,
          });
        }
        return;
      }
      if (method === WS_METHODS.subscribeServerSettings) {
        sendEffectRpcChunk(client, parsed.request.id, {
          settings: fixture.serverSettings,
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerKeepAwake ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents ||
        method === WS_METHODS.subscribeTodoEvents ||
        // Left open like the rest: these are infinite subscriptions, and the
        // default below answers with an Exit, which a stream RPC reads as the
        // socket dying and answers with a full reconnect. That loops forever
        // and starves the RPCs these tests are actually asserting on.
        method === DEVICE_WS_METHODS.subscribeEvents ||
        method === COMPUTER_WS_METHODS.subscribeEvents ||
        method === GUEST_SHARE_WS_METHODS.subscribe ||
        // Realtime Voice is a process-long stream. Completing it here would
        // create a reconnect loop in every full-app ChatView browser case.
        method === WS_METHODS.realtimeVoiceSubscribe
      ) {
        return;
      }
      try {
        sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
      } catch (error) {
        // Expected service errors are RPC failures, not uncaught socket events.
        // Keep unexpected fixture defects visible to Vitest.
        if (!Schema.is(WsRpcError)(error)) throw error;
        sendEffectRpcFailure(client, parsed.request.id, error);
      }
    });
  }),
  http.get(`*${LOCAL_IMAGE_ROUTE_PATH}`, ({ request }) => {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    if (url.searchParams.get("download") === "1") {
      localImageDownloadRequests.push(request.url);
    }
    const generated = path.includes("generated-preview");
    const width = generated ? 800 : 160;
    const height = generated ? 600 : 120;
    const color = path.includes("regular") ? "#7c3aed" : "#2563eb";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`;
    return HttpResponse.text(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.post(`*${ATTACHMENT_UPLOAD_ROUTE_PATH}`, async ({ request }) => {
    const url = new URL(request.url);
    const bytes = await request.arrayBuffer();
    await attachmentUploadBarrier;
    attachmentUploadSequence += 1;
    return HttpResponse.json(
      {
        type: url.searchParams.get("type") ?? "file",
        id: `att_v2_${String(attachmentUploadSequence).padStart(32, "0")}`,
        name: url.searchParams.get("name") ?? "attachment.bin",
        mimeType: url.searchParams.get("mimeType") ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
      },
      { status: 201 },
    );
  }),
  http.post(`*${ATTACHMENT_CANCEL_ROUTE_PATH}`, async () => {
    await attachmentCancelBarrier;
    return HttpResponse.json({ cancelled: true }, { status: 200 });
  }),
  http.get("*/attachments/:attachmentId", async () => {
    if (attachmentResponseDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(() => resolve(), attachmentResponseDelayMs);
      });
    }
    return HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    });
  }),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

// React development builds capture an owner stack (an Error plus a console task)
// for the first 10,000 elements created after each reset, and reset at most once
// per wall-clock second. Whether a render lands inside that budget depends on
// timing, not on the rendered tree, and costs the same ~20 ms per Issue #550
// step at every thread size, so it decided that benchmark's ratio at random.
// Production builds never capture these stacks; report the budget as spent.
export function skipReactDevOwnerStacks(): () => void {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: Record<string, unknown>;
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  // Fail loudly if a React upgrade renames the counter, instead of silently
  // bringing the timing-dependent capture back into the measurement.
  if (typeof internals?.recentlyCreatedOwnerStacks !== "number") {
    throw new Error("React no longer exposes recentlyCreatedOwnerStacks in development.");
  }
  Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
    configurable: true,
    get: () => Number.POSITIVE_INFINITY,
    set: () => {},
  });
  return () => {
    Object.defineProperty(internals, "recentlyCreatedOwnerStacks", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 0,
    });
  };
}

export async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function mousePointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

export async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

export async function waitForTranscriptLayoutToSettle(container: HTMLElement): Promise<void> {
  let lastTop = container.scrollTop;
  let lastHeight = container.scrollHeight;
  let lastViewportHeight = container.clientHeight;
  let stableSince = performance.now();
  const scrollOffsets = [lastTop];
  await vi.waitFor(
    () => {
      if (
        container.scrollTop !== lastTop ||
        container.scrollHeight !== lastHeight ||
        container.clientHeight !== lastViewportHeight
      ) {
        lastTop = container.scrollTop;
        lastHeight = container.scrollHeight;
        lastViewportHeight = container.clientHeight;
        stableSince = performance.now();
        scrollOffsets.push(lastTop);
        if (scrollOffsets.length > 20) scrollOffsets.shift();
      }
      expect(
        performance.now() - stableSince,
        `Transcript scroll did not settle: ${scrollOffsets.join(" -> ")} (height ${container.scrollHeight}, viewport ${container.clientHeight})`,
      ).toBeGreaterThanOrEqual(150);
    },
    { timeout: 3_000, interval: 20 },
  );
}

/**
 * Whether the virtualized transcript is actually painted. LegendList keeps its
 * container wrapper at `opacity: 0` until its own initial scroll has finished,
 * so scroll corrections taken before that are invisible and must not count as
 * a visible scroll flight.
 */
export function isTranscriptContentVisible(scrollContainer: HTMLElement): boolean {
  const wrapper = scrollContainer.querySelector<HTMLElement>('div[style*="opacity"]');
  if (!wrapper) {
    return false;
  }
  return Number.parseFloat(wrapper.style.opacity || "1") > 0;
}

/**
 * Samples the transcript's scroll position every frame while it is visible.
 * `downwardTravelPx` is the distance the reader actually watches the transcript
 * move; `maxDistanceFromBottomPx` is how far from the live edge it ever sat.
 */
export async function recordTranscriptScrollTravel(durationMs: number): Promise<{
  readonly downwardTravelPx: number;
  readonly maxDistanceFromBottomPx: number;
  readonly visibleFrames: number;
}> {
  const startedAt = performance.now();
  let downwardTravelPx = 0;
  let maxDistanceFromBottomPx = 0;
  let visibleFrames = 0;
  let previousScrollTop: number | null = null;

  while (performance.now() - startedAt < durationMs) {
    await nextFrame();
    const container = document.querySelector<HTMLElement>("[data-chat-scroll-container='true']");
    if (!container || !isTranscriptContentVisible(container)) {
      previousScrollTop = null;
      continue;
    }
    if (container.scrollHeight <= container.clientHeight) {
      continue;
    }
    visibleFrames += 1;
    maxDistanceFromBottomPx = Math.max(
      maxDistanceFromBottomPx,
      getScrollContainerDistanceFromBottom(container),
    );
    if (previousScrollTop !== null) {
      downwardTravelPx += Math.max(0, container.scrollTop - previousScrollTop);
    }
    previousScrollTop = container.scrollTop;
  }

  return { downwardTravelPx, maxDistanceFromBottomPx, visibleFrames };
}

export function installImmediateScrollToSpy(
  scrollContainer: HTMLElement,
  config?: { readonly suspendSmoothScroll?: boolean },
): {
  readonly calls: ScrollToOptions[];
  readonly restore: () => void;
} {
  const originalScrollTo = scrollContainer.scrollTo;
  const calls: ScrollToOptions[] = [];
  scrollContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
    const normalized: ScrollToOptions =
      typeof options === "object" && options !== null
        ? options
        : {
            ...(typeof options === "number" ? { left: options } : {}),
            ...(typeof y === "number" ? { top: y } : {}),
          };
    calls.push(normalized);
    if (config?.suspendSmoothScroll && normalized.behavior === "smooth") {
      return;
    }
    if (typeof normalized.left === "number") {
      scrollContainer.scrollLeft = normalized.left;
    }
    if (typeof normalized.top === "number") {
      scrollContainer.scrollTop = normalized.top;
    }
    scrollContainer.dispatchEvent(new Event("scroll"));
  }) as typeof scrollContainer.scrollTo;

  return {
    calls,
    restore: () => {
      scrollContainer.scrollTo = originalScrollTo;
    },
  };
}

export async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

export async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

export async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

export async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

export function queryComposerShell(): HTMLElement {
  return document.querySelector<HTMLElement>(
    'form[data-chat-composer-form="true"] .chat-composer-shell',
  )!;
}

export async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

export async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

export const turnStartText = (request: (typeof wsRequests)[number]): string | null =>
  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
  typeof request.command === "object" &&
  request.command !== null &&
  "type" in request.command &&
  request.command.type === "thread.turn.start" &&
  "message" in request.command &&
  typeof request.command.message === "object" &&
  request.command.message !== null &&
  "text" in request.command.message &&
  typeof request.command.message.text === "string"
    ? request.command.message.text
    : null;

export function readDispatchedCommand(
  request: WsRequestEnvelope["body"],
): Record<string, unknown> | null {
  if (
    request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand ||
    typeof request.command !== "object" ||
    request.command === null
  ) {
    return null;
  }
  return request.command as Record<string, unknown>;
}

export function hasDispatchedCommandType(type: string): boolean {
  return wsRequests.some((request) => readDispatchedCommand(request)?.type === type);
}

export async function waitForEmptyLandingEnvPicker(): Promise<HTMLElement> {
  return waitForElement(
    () =>
      document.querySelector<HTMLElement>(
        '[data-empty-landing-controls] [data-composer-environment-picker="true"]',
      ),
    "Unable to find the empty-landing environment picker.",
  );
}

export async function waitForEmptyLandingBranchTrigger(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-empty-landing-controls] button[data-slot="combobox-trigger"]',
        ),
      ).find((trigger) => trigger.textContent?.trim() === label) ?? null,
    `Unable to find the empty-landing branch trigger "${label}".`,
  );
}

export async function readEmptyLandingEnvMode(): Promise<"local" | "worktree"> {
  const picker = await waitForEmptyLandingEnvPicker();
  return picker.textContent?.trim() === "Worktree" ? "worktree" : "local";
}

export async function setEmptyLandingEnvMode(mode: "local" | "worktree"): Promise<void> {
  if ((await readEmptyLandingEnvMode()) === mode) return;
  (await waitForEmptyLandingEnvPicker()).click();
  await page
    .getByRole("menuitem", {
      name: mode === "worktree" ? "New worktree" : "Local project",
      exact: true,
    })
    .click();
  await vi.waitFor(
    async () => {
      expect(await readEmptyLandingEnvMode()).toBe(mode);
    },
    { timeout: 8_000, interval: 16 },
  );
}

// The config subscription opens with a full snapshot that seeds the client
// cache at boot, so a separate `server.getConfig` request is not guaranteed.
function hasRequestedServerConfig(): boolean {
  return wsRequests.some(
    (request) =>
      request._tag === WS_METHODS.serverGetConfig ||
      request._tag === WS_METHODS.subscribeServerConfig,
  );
}

export async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(hasRequestedServerConfig()).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

/** Resolves once `performance.now()` reaches `time` (at once if it already has). */
export function waitUntilPerformanceTime(time: number): Promise<void> {
  return new Promise<void>((resolve) =>
    window.setTimeout(resolve, Math.max(0, time - performance.now())),
  );
}

export function dispatchComposerPickerShortcut(target: EventTarget, key: "m" | "e"): void {
  const useMetaForMod = isMacNavigatorPlatform();
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function dispatchModelCycleShortcut(target: EventTarget, key: "[" | "]"): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key === "]" ? "BracketRight" : "BracketLeft",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

export async function dispatchModelCycleShortcutWhenReady(
  target: EventTarget,
  key: "[" | "]",
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchModelCycleShortcut(target, key).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

export function dispatchConfiguredShortcut(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): KeyboardEvent {
  const useMetaForMod = isMacNavigatorPlatform();
  const event = new KeyboardEvent("keydown", {
    key: input.key,
    shiftKey: input.shiftKey ?? false,
    altKey: input.altKey ?? false,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

// Re-dispatches until the shortcut handler consumes the event: the resolved
// keybindings land asynchronously after `serverGetConfig`, so a single dispatch
// can race the config apply.
export async function dispatchConfiguredShortcutWhenReady(
  target: EventTarget,
  input: { key: string; shiftKey?: boolean; altKey?: boolean },
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(dispatchConfiguredShortcut(target, input).defaultPrevented).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

// Cmd+L on macOS, Ctrl+L elsewhere: off macOS `meta` is the Windows/Super key, and
// Win+L locks the computer before Moss ever sees it.
export function dispatchComposerFocusToggleShortcut(
  chord: "platform" | "meta" = "platform",
): KeyboardEvent {
  const useMeta = chord === "meta" || isMacNavigatorPlatform();
  const event = new KeyboardEvent("keydown", {
    key: "l",
    metaKey: useMeta,
    ctrlKey: !useMeta,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

// The composer model/effort shortcuts both drop into the same combined picker,
// rendered as a Base UI menu popup. Provider and effort detail live in lazily
// mounted submenus, so the reliable signal that the surface opened is the popup
// mounting with the active model label (the fixture pins the thread to gpt-5).
export async function waitForComposerPickerSurfaceOpen(): Promise<void> {
  await vi.waitFor(() => {
    const popup = document.querySelector('[data-slot="menu-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent ?? "").toContain("GPT-5");
  });
}

export function dispatchChatNewShortcut(): void {
  dispatchThreadShortcut("o");
}

export function dispatchTerminalThreadShortcut(): void {
  dispatchThreadShortcut("t");
}

export function dispatchThreadShortcut(key: string): void {
  const useMetaForMod = isMacNavigatorPlatform();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(router, dispatchChatNewShortcut, predicate, errorMessage);
}

export async function triggerTerminalThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  return triggerThreadShortcutUntilPath(
    router,
    dispatchTerminalThreadShortcut,
    predicate,
    errorMessage,
  );
}

export async function triggerThreadShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  dispatchShortcut: () => void,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

export async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await waitForLayout();
}

export async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

export async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = measuredRow!.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx };
}

export async function measureChatLayout(host: HTMLElement): Promise<ChatLayoutMeasurement> {
  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
    "Unable to find ChatView message scroll container.",
  );
  const composerForm = await waitForElement(
    () => host.querySelector<HTMLElement>("[data-chat-composer-form='true']"),
    "Unable to find chat composer form.",
  );

  await waitForLayout();

  const hostHeightPx = host.getBoundingClientRect().height;
  const composerBottomPx = composerForm.getBoundingClientRect().bottom;
  return {
    hostHeightPx,
    composerBottomPx,
    scrollClientHeightPx: scrollContainer.clientHeight,
    scrollHeightPx: scrollContainer.scrollHeight,
    distanceFromBottomPx: getScrollContainerDistanceFromBottom(scrollContainer),
  };
}

export const CHAT_READINESS_WAIT_OPTIONS = { timeout: 20_000, interval: 16 };

export async function waitForSplitChatReady(threadIds: readonly ThreadId[]): Promise<void> {
  // Empty secondary threads have a composer before detail hydration. Capture
  // DOM identity after their loading layout has become the real empty landing.
  await vi.waitFor(() => {
    const state = useStore.getState();
    for (const threadId of threadIds) {
      const subscribeRequests = wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
          "threadId" in request &&
          request.threadId === threadId,
      ).length;
      expect(
        state.threadDetailSyncById?.[threadId],
        `Split thread ${threadId} did not hydrate (${subscribeRequests} subscribe requests).`,
      ).toBe("synced");
    }
    expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(threadIds.length);
  }, CHAT_READINESS_WAIT_OPTIONS);
  await waitForLayout();
}

export async function waitForMountedChatReady(options: {
  host: HTMLElement;
  snapshot: OrchestrationReadModel;
  routeThreadId: ThreadId;
}): Promise<void> {
  const expectedThread = options.snapshot.threads.find(
    (thread) => thread.id === options.routeThreadId,
  );

  await vi.waitFor(() => {
    expect(
      options.host.querySelector("[data-chat-composer-form='true']"),
      "Chat composer did not mount.",
    ).toBeTruthy();
    expect(hasRequestedServerConfig(), "Browser RPC configuration did not load.").toBe(true);

    if (!expectedThread) return;
    const state = useStore.getState();
    expect(state.threadIds?.includes(expectedThread.id)).toBe(true);
    const hydratedMessageIdSet = new Set(state.messageIdsByThreadId?.[expectedThread.id] ?? []);
    expect(
      expectedThread.messages.every((message) => hydratedMessageIdSet.has(message.id)),
      "Active thread detail did not hydrate.",
    ).toBe(true);
  }, CHAT_READINESS_WAIT_OPTIONS);
  await waitForLayout();
}

export async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  initialEntry?: string;
  onRender?: ProfilerOnRenderCallback;
  strictMode?: boolean;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = createFullscreenTestHost();

  const initialEntry = options.initialEntry ?? `/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialEntry],
    }),
  );
  // Seed before first render so the app-rail usage rings read the batch
  // snapshot immediately instead of racing a per-provider live fetch.
  router.options.context.queryClient.setQueryData(
    ["server", "allProviderUsage", null, null],
    createRailUsageFixtureSnapshots(),
  );

  const content = options.onRender ? (
    <Profiler id="issue-550-root" onRender={options.onRender}>
      <RouterProvider router={router} />
    </Profiler>
  ) : (
    <RouterProvider router={router} />
  );
  const screen = await render(
    options.strictMode ? <React.StrictMode>{content}</React.StrictMode> : content,
    {
      container: host,
    },
  );

  try {
    await waitForMountedChatReady({
      host,
      snapshot: options.snapshot,
      routeThreadId: ThreadId.makeUnsafe(initialEntry.slice(1)),
    });
  } catch (cause) {
    await screen.unmount();
    if (host.isConnected) host.remove();
    throw cause;
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    if (host.isConnected) host.remove();
    // React Query retries and background refetches outlive the unmounted tree.
    // A leftover provider-discovery retry can recreate the websocket API inside
    // the next test's beforeEach reset window, before that test configures its
    // fixture; the transport then caches the neutral fixture's welcome, which
    // onServerWelcome replays, so the next mount never receives its workspace
    // paths. Cancel and drop this mount's queries so nothing outlives the test.
    await router.options.context.queryClient.cancelQueries();
    router.options.context.queryClient.clear();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureLayout: async () => measureChatLayout(host),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

export function withoutProjectDefaultModelSelection(
  snapshot: OrchestrationReadModel,
  projectId: ProjectId = PROJECT_ID,
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId ? { ...project, defaultModelSelection: null } : project,
    ),
  };
}

export const MOSS_MANAGED_CODEX_TEST_MODELS = MOSS_CODEX_RESPONSES_MODEL_IDS;

export function configureMossManagedDefaults(nextFixture: TestFixture): void {
  nextFixture.serverSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [
          {
            id: "moss",
            label: "Moss",
            homePath: "/tmp/codex-moss",
            shadowHomePath: "",
          },
        ],
        selectedAccountId: "moss",
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        displayName: "Moss",
        enabled: true,
        config: {
          homePath: "/tmp/codex-moss",
          accountId: "moss",
          customModels: [...MOSS_MANAGED_CODEX_TEST_MODELS],
          modelAllowlist: [...MOSS_MANAGED_CODEX_TEST_MODELS],
          defaultModel: "gpt-5.6-sol",
          managed: true,
        },
      },
      claude_moss: {
        driver: "claudeAgent",
        displayName: "Moss",
        enabled: true,
        config: {
          customModels: ["claude-sonnet-4-6"],
          modelAllowlist: ["claude-sonnet-4-6"],
          defaultModel: "claude-sonnet-4-6",
          managed: true,
        },
      },
    },
  };
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    providers: [
      ...nextFixture.serverConfig.providers,
      {
        provider: "codex",
        instanceId: "codex_moss",
        driver: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
      {
        provider: "claudeAgent",
        instanceId: "claude_moss",
        driver: "claudeAgent",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
  };
}

export function configureMossManagedWithDisconnectedPersonalAccount(
  nextFixture: TestFixture,
): void {
  configureMossManagedDefaults(nextFixture);
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    providers: nextFixture.serverConfig.providers
      .filter((provider) => provider.instanceId !== "claude_moss")
      .map((provider) =>
        provider.instanceId === "codex"
          ? {
              ...provider,
              status: "error" as const,
              available: false,
              authStatus: "unauthenticated" as const,
            }
          : provider,
      ),
  };
}

export function withImageGenerationLimitActivity(
  snapshot: OrchestrationReadModel,
  options: {
    threadId?: ThreadId;
    providerInstanceId?: string;
    turnId?: string;
    activityId?: string;
    createdAt?: string;
    resetsAt?: number | null;
  } = {},
): OrchestrationReadModel {
  const threadId = options.threadId ?? THREAD_ID;
  const providerInstanceId = options.providerInstanceId ?? "codex";
  const activityId = options.activityId ?? `activity-image-limit-${providerInstanceId}`;
  const turnId = TurnId.makeUnsafe(options.turnId ?? "turn-image-limit");
  const activity = {
    id: EventId.makeUnsafe(activityId),
    createdAt: options.createdAt ?? NOW_ISO,
    kind: "tool.completed" as const,
    summary: "Image generation failed",
    tone: "error" as const,
    turnId,
    sequence: 1,
    payload: {
      itemType: "image_generation",
      providerInstanceId,
      status: "failed",
      data: {
        kind: "codex.image_generation.usage_limit",
        type: "usageLimitExceeded",
        limitId: "image_gen",
        resetsAt: options.resetsAt ?? null,
      },
    },
  };
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            modelSelection: {
              ...thread.modelSelection,
              instanceId: providerInstanceId as typeof thread.modelSelection.instanceId,
              ...(providerInstanceId === "codex_moss" ? { model: "gpt-5.6-sol" } : {}),
            },
            activities: [...thread.activities, activity],
          }
        : thread,
    ),
  } as OrchestrationReadModel;
}

export function withImageGenerationCompletionActivity(
  snapshot: OrchestrationReadModel,
  options: {
    threadId?: ThreadId;
    providerInstanceId?: string;
    turnId?: string;
    activityId?: string;
    createdAt?: string;
  } = {},
): OrchestrationReadModel {
  const threadId = options.threadId ?? THREAD_ID;
  const providerInstanceId = options.providerInstanceId ?? "codex";
  const activity = {
    id: EventId.makeUnsafe(options.activityId ?? `activity-image-success-${providerInstanceId}`),
    createdAt: options.createdAt ?? isoAt(5),
    kind: "tool.completed" as const,
    summary: "Generated image",
    tone: "tool" as const,
    turnId: TurnId.makeUnsafe(options.turnId ?? "turn-image-success"),
    sequence: 2,
    payload: {
      itemType: "image_generation",
      providerInstanceId,
      status: "completed",
      data: {
        kind: "codex.generated_image",
        path: "/tmp/image-generation-limit-success.png",
      },
    },
  };
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId ? { ...thread, activities: [...thread.activities, activity] } : thread,
    ),
  } as OrchestrationReadModel;
}

export function withAccountRateLimitActivity(
  snapshot: OrchestrationReadModel,
  status: "rejected" | "allowed_warning",
): OrchestrationReadModel {
  const activity = {
    id: EventId.makeUnsafe(`activity-account-rate-limit-${status}`),
    createdAt: isoAt(9),
    kind: "account.rate-limited",
    summary: status === "rejected" ? "Rate limit reached" : "Approaching rate limit",
    tone: status === "rejected" ? ("error" as const) : ("info" as const),
    turnId: TurnId.makeUnsafe("turn-account-rate-limit"),
    sequence: 3,
    payload: {
      status,
      resetsAt: "2099-01-01T00:00:00.000Z",
      ...(status === "allowed_warning" ? { utilization: 0.9 } : {}),
    },
  };
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? { ...thread, activities: [...thread.activities, activity] }
        : thread,
    ),
  } as OrchestrationReadModel;
}

export function makeProviderUsageSnapshot(
  planName: string | undefined,
  providerInstanceId = "codex",
): ServerProviderUsageSnapshot {
  return {
    provider: "codex",
    providerInstanceId: providerInstanceId as ServerProviderUsageSnapshot["providerInstanceId"],
    updatedAt: NOW_ISO,
    limits: [],
    usageLines: [],
    source: "browser.image-generation-limit-fixture",
    status: "ok",
    ...(planName === undefined ? {} : { planName }),
  };
}

export function createSnapshotWithGeneratedImagePreview(options?: {
  imageCount?: number;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-generated-image-preview" as MessageId,
    targetText: "generated image preview",
  });
  const generatedTurnId = TurnId.makeUnsafe("turn-generated-image-preview");
  const imageCount = Math.max(2, Math.trunc(options?.imageCount ?? 2));
  const generatedImages = Array.from({ length: imageCount }, (_, index) => {
    const ordinal = index + 1;
    const word = ["one", "two", "three", "four", "five", "six", "seven", "eight"][index];
    return {
      id: `generated-preview-${word ?? ordinal}`,
      path: `/tmp/generated-preview-${word ?? ordinal}.png`,
    };
  });
  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex < 0) {
    return snapshot;
  }
  const thread = threads[threadIndex]!;
  const messages = [...thread.messages];
  const regularMessageIndex = messages.length - 1;
  const regularMessage = messages[regularMessageIndex];
  if (regularMessage) {
    messages[regularMessageIndex] = {
      ...regularMessage,
      text: "A regular markdown image.\n\n![Regular image](/tmp/regular.png)",
    };
  }

  threads[threadIndex] = {
    ...thread,
    messages,
    activities: generatedImages.map((image, index) => ({
      id: EventId.makeUnsafe(`activity-${image.id}`),
      createdAt: isoAt(1_000 + index),
      kind: "tool.completed" as const,
      summary: "Generated image",
      tone: "tool" as const,
      turnId: generatedTurnId,
      sequence: index + 1,
      payload: {
        itemType: "image_generation",
        data: {
          kind: "codex.generated_image",
          path: image.path,
          callId: image.id,
        },
      },
    })),
  };
  return {
    ...snapshot,
    threads,
  };
}

export function createSnapshotWithInterruptedTurn(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-resume-browser" as MessageId,
    targetText: "resume interrupted browser target",
  });
  const turnId = TurnId.makeUnsafe("turn-resume-interrupted-browser");
  const interruptedAt = isoAt(2_002);

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: {
              turnId,
              state: "interrupted" as const,
              requestedAt: isoAt(2_000),
              startedAt: isoAt(2_001),
              completedAt: interruptedAt,
              assistantMessageId: null,
            },
            activities: [],
            session: thread.session
              ? {
                  ...thread.session,
                  status: "interrupted" as const,
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: interruptedAt,
                }
              : null,
            updatedAt: interruptedAt,
          }
        : thread,
    ),
    updatedAt: interruptedAt,
  };
}

export function updateInterruptedThreadSnapshot(
  snapshot: OrchestrationReadModel,
  update: (
    thread: OrchestrationReadModel["threads"][number],
  ) => OrchestrationReadModel["threads"][number],
): OrchestrationReadModel {
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => (thread.id === THREAD_ID ? update(thread) : thread)),
  };
}

export function createSnapshotWithPendingApproval(
  approvalScope?: "computer-foreground",
): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-moss-visible-approval-parity" as MessageId,
    targetText: "moss visible approval parity target",
    sessionStatus: "running",
  });
  const activeTurnId = TurnId.makeUnsafe("turn-moss-visible-approval");
  const requestId = "approval-moss-visible";

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => {
      if (thread.id !== THREAD_ID) return thread;
      const session = thread.session ?? {
        threadId: THREAD_ID,
        status: "running" as const,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW_ISO,
      };

      return {
        ...thread,
        latestTurn: {
          turnId: activeTurnId,
          state: "running" as const,
          requestedAt: isoAt(1_000),
          startedAt: isoAt(1_001),
          completedAt: null,
          assistantMessageId: null,
        },
        activities: [
          ...thread.activities,
          {
            id: EventId.makeUnsafe("activity-moss-visible-approval"),
            tone: "approval" as const,
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId,
              requestKind: approvalScope ? "tool" : "command",
              ...(approvalScope ? { approvalScope, toolName: "computer_activate_window" } : {}),
            },
            sequence: 1,
            turnId: activeTurnId,
            createdAt: isoAt(1_002),
          },
        ],
        session: {
          ...session,
          status: "running" as const,
          activeTurnId,
        },
      };
    }),
  };
}

export function createRealtimeVoiceRouteSnapshot(): OrchestrationReadModel {
  const snapshot = addThreadToSnapshot(
    createSnapshotForTargetUser({
      targetMessageId: "msg-user-realtime-voice-route-owner" as MessageId,
      targetText: "voice owner route target",
    }),
    OTHER_THREAD_ID,
  );
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === OTHER_THREAD_ID
        ? {
            ...thread,
            title: "Ordinary B thread",
            messages: [
              createUserMessage({
                id: "msg-user-realtime-voice-route-b" as MessageId,
                text: "ordinary B route target",
                offsetSeconds: 5_000,
              }),
            ],
          }
        : thread,
    ),
  };
}

export function createEmptyRealtimeVoiceRouteSnapshot(): OrchestrationReadModel {
  const snapshot = createRealtimeVoiceRouteSnapshot();
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? {
            ...thread,
            latestTurn: null,
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
          }
        : thread,
    ),
  };
}

export function seedProjectDraftThreadForLandingTest(
  threadId: ThreadId = THREAD_ID,
  projectId: ProjectId = PROJECT_ID,
): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {
      [threadId]: {
        projectId,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        entryPoint: "chat",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    projectDraftThreadIdByProjectId: { [projectId]: threadId },
  });
}

export interface MossVisibleSequenceSubscriptionRecord {
  readonly input: { readonly threadId: ThreadId };
  readonly onEvent: (event: MossNormalizedSessionEvent) => void;
  readonly unsubscribe: () => void;
  closed: boolean;
}

export function createMossVisibleSequenceEvent(
  type: MossNormalizedSessionEvent["type"],
  payload: Record<string, unknown>,
  index: number,
  overrides: Partial<Pick<MossNormalizedSessionEvent, "sessionId" | "threadId">> = {},
): MossNormalizedSessionEvent {
  const seconds = String(index).padStart(2, "0");
  return {
    eventId: EventId.makeUnsafe(`moss-visible-sequence-normalized-${index}`),
    type,
    provider: "codex",
    sessionId: MOSS_SEQUENCE_SESSION_ID,
    threadId: THREAD_ID,
    turnId: TurnId.makeUnsafe("turn-moss-visible-sequence"),
    createdAt: `2026-07-02T00:07:${seconds}.000Z`,
    rawEventId: EventId.makeUnsafe(`moss-visible-sequence-raw-${index}`),
    payload,
    ...overrides,
  };
}

export function createMossVisibleSequenceEvents(): ReadonlyArray<MossNormalizedSessionEvent> {
  return [
    createMossVisibleSequenceEvent(
      "text",
      {
        text: "moss visible sequence assistant text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:moss-visible-sequence-primary",
        rawSource: "codex.raw.sequence.text",
      },
      1,
    ),
    createMossVisibleSequenceEvent(
      "tool-call",
      {
        status: "running",
        title: "Inspect launch plan",
        itemId: "moss-visible-sequence-tool",
        toolName: "exec_command",
        rawSource: "codex.raw.sequence.tool-call",
      },
      2,
    ),
    createMossVisibleSequenceEvent(
      "tool-result",
      {
        status: "completed",
        title: "Inspect launch plan",
        itemId: "moss-visible-sequence-tool",
        toolName: "exec_command",
        detail: "tool lifecycle completed",
        rawSource: "codex.raw.sequence.tool-result",
      },
      3,
    ),
    createMossVisibleSequenceEvent(
      "permission-request",
      {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Approve Moss sequence command",
        rawSource: "codex.raw.sequence.approval",
      },
      4,
    ),
    createMossVisibleSequenceEvent(
      "usage",
      {
        usage: { inputTokens: 1234, outputTokens: 234, totalTokens: 1468 },
        model: "gpt-5.3-codex",
        rawSource: "codex.raw.sequence.usage",
      },
      5,
    ),
    createMossVisibleSequenceEvent(
      "finish",
      {
        state: "completed",
        stopReason: "stop",
        rawSource: "codex.raw.sequence.finish",
      },
      6,
    ),
    createMossVisibleSequenceEvent(
      "text",
      {
        text: "moss visible sequence secondary session text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:moss-visible-sequence-secondary",
        rawSource: "claude.raw.sequence.text",
      },
      7,
      { threadId: OTHER_THREAD_ID, sessionId: MOSS_SEQUENCE_SECONDARY_SESSION_ID },
    ),
  ];
}

export function createMossVisibleSequenceProviderSessions(): ReadonlyArray<ProviderSession> {
  return [
    {
      provider: "codex",
      status: "running",
      runtimeMode: "full-access",
      cwd: "/Users/moss/Codex/tools/moss",
      model: "gpt-5.3-codex",
      threadId: THREAD_ID,
      activeTurnId: TurnId.makeUnsafe("turn-moss-visible-sequence"),
      createdAt: "2026-07-02T00:07:00.000Z",
      updatedAt: "2026-07-02T00:07:06.000Z",
    },
    {
      provider: "claudeAgent",
      status: "ready",
      runtimeMode: "approval-required",
      cwd: "/Users/moss/Codex/tools/secondary-agent",
      model: "claude-sonnet-4-6",
      threadId: OTHER_THREAD_ID,
      createdAt: "2026-07-02T00:07:01.000Z",
      updatedAt: "2026-07-02T00:07:02.000Z",
    },
  ];
}

export function installMossVisibleSequenceNativeApi() {
  const baseNativeApi = readNativeApi();
  if (!baseNativeApi) {
    throw new Error("Expected test nativeApi before installing Moss sequence provider stub.");
  }
  const previousNativeApi = window.nativeApi;

  const normalizedEvents = createMossVisibleSequenceEvents();
  const normalizedEventSubscriptions: MossVisibleSequenceSubscriptionRecord[] = [];
  const listSessions = vi.fn(async () => ({
    sessions: createMossVisibleSequenceProviderSessions(),
  }));
  const getLaunchPlan = vi.fn(async (input: { threadId: ThreadId }) => ({
    threadId: input.threadId,
    planHash:
      String(input.threadId) === String(OTHER_THREAD_ID)
        ? "sha256:moss-visible-sequence-secondary"
        : "sha256:moss-visible-sequence-primary",
    launchPlan: null,
  }));
  const getLoopLedgerDashboardSnapshot = vi.fn(async (input: { threadId: ThreadId }) => ({
    threadId: input.threadId,
    snapshot: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
      generatedAt: "2026-07-02T00:07:00.000Z",
      tasks: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks,
        active: [
          {
            taskId: "moss-task-0080",
            title: "Gate real-provider shell interaction sequencing",
            owner: "Runtime Adapter Engineer",
            status: "active" as const,
            acceptanceCount: 5,
            evidenceCount: 1,
          },
        ],
      },
    },
  }));
  const submitPermissionAction = vi.fn(
    async (
      input: ProviderSubmitPermissionActionInput,
    ): Promise<ProviderSubmitPermissionActionResult> => ({
      ...input,
      status: "accepted",
      message: "Moss sequence permission accepted.",
    }),
  );
  const subscribeNormalizedSessionEvents = vi.fn(
    (input: { threadId: ThreadId }, onEvent: (event: MossNormalizedSessionEvent) => void) => {
      let record: MossVisibleSequenceSubscriptionRecord;
      const unsubscribe = vi.fn(() => {
        record.closed = true;
      });
      record = {
        input,
        onEvent,
        unsubscribe,
        closed: false,
      };
      normalizedEventSubscriptions.push(record);

      const inputThreadId = String(input.threadId);
      for (const event of normalizedEvents) {
        if (String(event.threadId) === inputThreadId) {
          onEvent(event);
        }
      }

      return record.unsubscribe;
    },
  );

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    writable: true,
    value: {
      ...baseNativeApi,
      provider: {
        ...baseNativeApi.provider,
        getLaunchPlan,
        getLoopLedgerDashboardSnapshot,
        listSessions,
        submitPermissionAction,
        subscribeNormalizedSessionEvents,
      },
    } satisfies NativeApi,
  });

  return {
    emitNormalizedEvent(event: MossNormalizedSessionEvent) {
      for (const record of normalizedEventSubscriptions) {
        if (record.closed || String(record.input.threadId) !== String(event.threadId)) {
          continue;
        }
        record.onEvent(event);
      }
    },
    getLaunchPlan,
    getLoopLedgerDashboardSnapshot,
    listSessions,
    normalizedEventSubscriptions,
    restore() {
      if (previousNativeApi) {
        Object.defineProperty(window, "nativeApi", {
          configurable: true,
          writable: true,
          value: previousNativeApi,
        });
      } else {
        Reflect.deleteProperty(window, "nativeApi");
      }
    },
    submitPermissionAction,
    subscribeNormalizedSessionEvents,
  };
}

export function installImageLimitDiagnostics() {
  const consoleMessages: Array<{ level: "error" | "warn"; text: string }> = [];
  const onError = (event: ErrorEvent) => {
    consoleMessages.push({
      level: "error",
      text:
        event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    consoleMessages.push({
      level: "error",
      text:
        event.reason instanceof Error
          ? (event.reason.stack ?? event.reason.message)
          : String(event.reason),
    });
  };
  const errorSpy = vi.spyOn(console, "error");
  const warnSpy = vi.spyOn(console, "warn");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return {
    assertHealthy() {
      consoleMessages.push(
        ...errorSpy.mock.calls.map((args) => ({
          level: "error" as const,
          text: args.map(String).join(" "),
        })),
        ...warnSpy.mock.calls.map((args) => ({
          level: "warn" as const,
          text: args.map(String).join(" "),
        })),
      );
      const known = /(ResizeObserver|LegendList|legend-list)/iu;
      const unexpected = consoleMessages.filter(({ text }) => !known.test(text));
      expect(unexpected, "Unexpected browser console/page/React diagnostics").toEqual([]);
      return consoleMessages;
    },
    dispose() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

export const RESIZE_OBSERVER_LOOP_DIAGNOSTIC =
  "ResizeObserver loop completed with undelivered notifications.";

export function installGeneratedImageGalleryDiagnostics() {
  const pageErrors: string[] = [];
  const onError = (event: ErrorEvent) => {
    pageErrors.push(
      event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message,
    );
  };
  const errorSpy = vi.spyOn(console, "error");
  window.addEventListener("error", onError);
  return {
    assertNoResizeObserverLoop() {
      const consoleErrors = errorSpy.mock.calls.map((args) => args.map(String).join(" "));
      const resizeObserverErrors = [...pageErrors, ...consoleErrors].filter((message) =>
        message.includes(RESIZE_OBSERVER_LOOP_DIAGNOSTIC),
      );
      expect(
        resizeObserverErrors,
        `Unexpected ResizeObserver diagnostic count: ${resizeObserverErrors.length}`,
      ).toEqual([]);
    },
    dispose() {
      window.removeEventListener("error", onError);
      errorSpy.mockRestore();
    },
  };
}

export function readImageLimitThemeReceipt(banner: HTMLElement) {
  const description = banner.querySelector<HTMLElement>("p:nth-of-type(2)");
  const style = getComputedStyle(banner);
  const descriptionStyle = description ? getComputedStyle(description) : null;
  expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(descriptionStyle?.color).not.toBe("rgba(0, 0, 0, 0)");
  return {
    background: style.backgroundColor,
    border: style.borderTopColor,
    foreground: style.color,
    description: descriptionStyle?.color ?? "",
  };
}

export function setImageLimitFixtureTheme(theme: "light" | "dark") {
  localStorage.setItem("moss:theme", theme);
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme", newValue: theme }));
}

// These fixtures do not host the Canvas runtime. A dev-server HTML fallback
// must not create a frame that cannot acknowledge the real save guard.
export async function withMissingCanvasBundle(work: () => Promise<void>): Promise<void> {
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.origin,
    );
    if (url.origin === window.location.origin && url.pathname === "/canvas/") {
      return Promise.resolve(new Response("Canvas bundle missing", { status: 503 }));
    }
    return originalFetch.call(window, input, init);
  };
  try {
    await work();
  } finally {
    window.fetch = originalFetch;
  }
}

// A click on a generated image opens the lightbox; the Canvas chip opens the
// image workspace in Canvas view, and its view toggle returns to the focused image.
export async function openGeneratedImageFocusPane(preview: HTMLElement): Promise<void> {
  await withMissingCanvasBundle(async () => {
    const chip = await waitForElement(
      () =>
        preview.parentElement?.querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-open-canvas"]',
        ) ?? null,
      "Unable to find the generated image Canvas chip.",
    );
    chip.click();
    const pane = () =>
      document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]');
    // Settle the Canvas view and its missing-bundle response before switching.
    // Otherwise a dev-server fallback can race this click and invoke a save
    // guard for an iframe that is not a Canvas editor.
    await vi.waitFor(
      () => {
        expect(pane()?.getAttribute("data-generated-image-preview-view")).toBe("playground");
        expect(pane()?.getAttribute("data-generated-image-preview-transitioning")).toBe("false");
      },
      { timeout: 8_000, interval: 16 },
    );
    await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
    expect(document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    await vi.waitFor(
      () => {
        const focusView = document.querySelector<HTMLButtonElement>(
          '[data-testid="generated-image-preview-view-single"]',
        );
        if (pane()?.getAttribute("data-generated-image-preview-view") !== "single") {
          if (focusView && !focusView.disabled) focusView.click();
        }
        expect(pane()?.getAttribute("data-generated-image-preview-view")).toBe("single");
      },
      { timeout: 8_000, interval: 50 },
    );
  });
}

export function expectGeneratedImagePreviewReceipt(options?: { mobile?: boolean }): HTMLElement {
  const pane = document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]');
  expect(pane).not.toBeNull();
  const rect = pane?.getBoundingClientRect();
  expect(rect?.width).toBeGreaterThan(0);
  expect(rect?.height).toBeGreaterThan(0);
  expect(rect?.left).toBeGreaterThanOrEqual(0);
  expect(rect?.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(rect?.top).toBeGreaterThanOrEqual(0);
  expect(rect?.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  // The pane's tab draws its icon: an image preview's, or the one 画布 icon (WALK-4 N4-2).
  const canvasIcon = getCentralIconUrl(centralIconNameOf(spaceKindMeta("board").icon)!)!;
  expect(
    document.querySelector('[data-generated-image-icon="preview"]') ??
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-right-dock-tab-id] [data-slot="central-icon"]',
        ),
      ].find((icon) => icon.getAttribute("style")?.includes(canvasIcon)) ??
      null,
  ).not.toBeNull();
  if (options?.mobile) {
    const mobileSidebar = document.querySelector<HTMLElement>(
      '[data-sidebar="sidebar"][data-mobile="true"]',
    );
    expect(mobileSidebar).not.toBeNull();
    const mobileRect = mobileSidebar?.getBoundingClientRect();
    expect(mobileRect?.width).toBeGreaterThan(0);
    expect(mobileRect?.height).toBeGreaterThan(0);
    expect(mobileRect?.left).toBeGreaterThanOrEqual(0);
    expect(mobileRect?.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(mobileRect?.top).toBeGreaterThanOrEqual(0);
    expect(mobileRect?.bottom).toBeLessThanOrEqual(window.innerHeight + 1);

    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const centerY = (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
    const topElement = document.elementFromPoint(centerX, centerY);
    expect(topElement && pane?.contains(topElement)).toBe(true);
    const composer = document.querySelector<HTMLElement>('form[data-chat-composer-form="true"]');
    if (composer && rect) {
      const composerRect = composer.getBoundingClientRect();
      const intersects =
        rect.left < composerRect.right &&
        rect.right > composerRect.left &&
        rect.top < composerRect.bottom &&
        rect.bottom > composerRect.top;
      const composerIsTopLayer = Boolean(topElement && composer.contains(topElement));
      expect(!intersects || !composerIsTopLayer).toBe(true);
    }
  }
  return pane!;
}

export function readGeneratedImagePreviewThemeReceipt(expectedVariant: "light" | "dark") {
  expect(document.documentElement.getAttribute("data-theme-variant")).toBe(expectedVariant);
  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-background-surface")
    .trim();
  const foreground = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-text-foreground")
    .trim();
  const surfaceElement =
    document.querySelector<HTMLElement>('[data-sidebar="sidebar"][data-mobile="true"]') ??
    document.querySelector<HTMLElement>('[data-slot="sidebar-container"]');
  const backgroundColor = surfaceElement ? getComputedStyle(surfaceElement).backgroundColor : "";
  const foregroundColor = surfaceElement ? getComputedStyle(surfaceElement).color : "";
  expect(surface).not.toBe("");
  expect(foreground).not.toBe("");
  expect(backgroundColor).not.toBe("");
  expect(foregroundColor).not.toBe("");
  return { surface, foreground, backgroundColor, foregroundColor };
}

export function expectGeneratedImagePreviewControlRectsInBounds(): void {
  const pane = document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]');
  expect(pane).not.toBeNull();
  const paneRect = pane?.getBoundingClientRect();
  expect(paneRect?.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(paneRect?.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  for (const selector of [
    '[data-testid="generated-image-preview-zoom-trigger"]',
    '[data-testid="generated-image-preview-download"]',
  ]) {
    const control = document.querySelector<HTMLElement>(selector);
    const rect = control?.getBoundingClientRect();
    expect(rect?.width).toBeGreaterThan(0);
    expect(rect?.height).toBeGreaterThan(0);
    expect(rect?.left).toBeGreaterThanOrEqual((paneRect?.left ?? 0) - 1);
    expect(rect?.top).toBeGreaterThanOrEqual((paneRect?.top ?? 0) - 1);
    expect(rect?.right).toBeLessThanOrEqual(Math.min(paneRect?.right ?? 0, window.innerWidth) + 1);
    expect(rect?.bottom).toBeLessThanOrEqual(
      Math.min(paneRect?.bottom ?? 0, window.innerHeight) + 1,
    );
  }
}

export async function openGeneratedImageEditorFromGallery(): Promise<void> {
  // Image clicks open the lightbox. Enter Canvas explicitly, then choose the
  // focused view that owns the preview zoom/download controls and image rail.
  const galleryPreview = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-preview"]'),
    "Unable to find the generated image gallery preview.",
  );
  // The chip is pointer-inert until hover/focus-within. Establish that state on
  // every mount, including dark/mobile runs with no preceding thumbnail clicks.
  galleryPreview.focus();
  await waitForElement(
    () => document.querySelector<HTMLButtonElement>('[data-testid="generated-image-open-canvas"]'),
    "Unable to find the loaded gallery's Canvas chip.",
  );
  await withMissingCanvasBundle(async () => {
    await page.getByTestId("generated-image-open-canvas").click();
    await vi.waitFor(() => {
      const pane = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-pane"]',
      );
      expect(pane?.dataset.generatedImagePreviewView).toBe("playground");
    });
    await expect.element(page.getByText("画布工作区暂不可用", { exact: true })).toBeVisible();
    expect(document.querySelector('iframe[title="Moss Canvas"]')).toBeNull();
    await page.getByTestId("generated-image-preview-view-single").click();
    await vi.waitFor(() => {
      const pane = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-pane"]',
      );
      expect(pane?.dataset.generatedImagePreviewView).toBe("single");
      expect(pane?.dataset.generatedImagePreviewTransitioning).toBe("false");
    });
    await waitForGeneratedImagePreviewControlsReady();
  });
}

export async function waitForGeneratedImagePreviewControlsReady(): Promise<void> {
  await vi.waitFor(
    () => {
      const zoom = document.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-zoom-trigger"]',
      );
      const download = document.querySelector<HTMLButtonElement>(
        '[data-testid="generated-image-preview-download"]',
      );
      expect(zoom).not.toBeNull();
      expect(download).not.toBeNull();
      expect(zoom?.disabled).toBe(false);
    },
    { timeout: 8_000, interval: 16 },
  );
}

export async function waitForGeneratedImagePreviewDockSettled(
  expectedFullWidth: boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      const pane = document.querySelector<HTMLElement>(
        '[data-testid="generated-image-preview-pane"]',
      );
      const panel = document.querySelector<HTMLElement>('[data-testid="right-dock-panel"]');
      expect(pane).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(pane?.getAttribute("data-generated-image-preview-full-width")).toBe(
        expectedFullWidth ? "true" : "false",
      );
      const paneRect = pane?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const host = document.querySelector<HTMLElement>(
        '[data-right-dock-layout-host][data-testid="thread-main-row"]',
      );
      const mainContent = document.querySelector<HTMLElement>("[data-right-dock-main-content]");
      expect(host).not.toBeNull();
      expect(host?.getAttribute("data-testid")).toBe("thread-main-row");
      expect(mainContent).not.toBeNull();
      expect(mainContent?.getAttribute("data-app-shell-right-panel-full-width")).toBe(
        expectedFullWidth ? "true" : "false",
      );
      const mainContentStyle = mainContent ? getComputedStyle(mainContent) : null;
      if (expectedFullWidth) {
        expect(mainContentStyle?.flex).toMatch(/0 0 auto|none/);
        expect(mainContentStyle?.width).toBe("0px");
        expect(mainContentStyle?.minWidth).toBe("0px");
        expect(mainContentStyle?.overflow).toBe("hidden");
        expect(mainContent?.getBoundingClientRect().width).toBeLessThanOrEqual(1);
      } else {
        expect(mainContentStyle?.flex).toMatch(/1 1 0%|auto/);
        expect(mainContentStyle?.overflow).toBe("visible");
        expect(mainContent?.getBoundingClientRect().width).toBeGreaterThan(0);
      }
      const hostRect = host?.getBoundingClientRect();
      // The rail shell deliberately insets the dock from the host edge
      // (--app-rail-inset-gap); measure flushness against the panel's own
      // computed inset rather than assuming a zero gap.
      const panelInsetRight = panel ? Number.parseFloat(getComputedStyle(panel).right) || 0 : 0;
      const hostRight =
        Math.min(window.innerWidth, hostRect?.right ?? window.innerWidth) - panelInsetRight;
      expect(paneRect?.width).toBeGreaterThan(0);
      expect(paneRect?.right).toBeGreaterThanOrEqual(hostRight - 1);
      expect(paneRect?.right).toBeLessThanOrEqual(hostRight + 1);
      expect(panelRect?.right).toBeGreaterThanOrEqual(hostRight - 1);
      expect(panelRect?.right).toBeLessThanOrEqual(hostRight + 1);
      if (expectedFullWidth) {
        expect(panelRect?.width).toBeGreaterThan((hostRect?.width ?? window.innerWidth) * 0.8);
      } else {
        expect(panelRect?.width).toBeLessThan((hostRect?.width ?? window.innerWidth) * 0.8);
      }
      const runningAnimations = [
        panel,
        panel?.closest<HTMLElement>("[data-slot='sidebar-wrapper']"),
      ]
        .filter((node): node is HTMLElement => node !== null)
        .flatMap((node) => node.getAnimations())
        .filter((animation) => animation.playState === "running");
      expect(runningAnimations).toHaveLength(0);
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
  await waitForGeneratedImagePreviewControlsReady();
  expectGeneratedImagePreviewControlRectsInBounds();
  const settledPanel = document.querySelector<HTMLElement>('[data-testid="right-dock-panel"]');
  expect(settledPanel).not.toBeNull();
  const sampledRightEdges: number[] = [];
  const sampledWidths: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    await nextFrame();
    const rect = settledPanel?.getBoundingClientRect();
    if (rect) {
      sampledRightEdges.push(rect.right);
      sampledWidths.push(rect.width);
    }
  }
  expect(sampledRightEdges.length).toBe(6);
  expect(Math.max(...sampledRightEdges) - Math.min(...sampledRightEdges)).toBeLessThanOrEqual(1);
  expect(Math.max(...sampledWidths) - Math.min(...sampledWidths)).toBeLessThanOrEqual(1);
}

export function createGeneratedImagePreviewTouchEvent(
  type: string,
  target: EventTarget,
  points: readonly { identifier: number; clientX: number; clientY: number }[],
): TouchEvent | null {
  if (typeof Touch === "undefined" || typeof TouchEvent === "undefined") {
    return null;
  }
  try {
    const touches = points.map(
      (point) =>
        new Touch({
          identifier: point.identifier,
          target,
          clientX: point.clientX,
          clientY: point.clientY,
          screenX: point.clientX,
          screenY: point.clientY,
          pageX: point.clientX,
          pageY: point.clientY,
        }),
    );
    return new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches,
      changedTouches: touches,
    });
  } catch {
    return null;
  }
}

export function installProviderRefreshNativeApi(
  refreshProviders: NativeApi["server"]["refreshProviders"],
): () => void {
  const previousNativeApi = window.nativeApi;
  const wsNativeApi = readNativeApi();
  if (!wsNativeApi) {
    throw new Error("Expected browser native API fixture.");
  }

  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...wsNativeApi,
      server: {
        ...wsNativeApi.server,
        refreshProviders,
      },
    },
  });

  return () => {
    if (previousNativeApi) {
      Object.defineProperty(window, "nativeApi", {
        configurable: true,
        value: previousNativeApi,
      });
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

/**
 * The image pane the side panel is showing. A closed side panel keeps its image and Canvas panes
 * mounted but inert (the residency policy decides when they unload), so "closed" means this is
 * null, not that the node is gone.
 */
export function shownGeneratedImagePreviewPane(): HTMLElement | null {
  const pane = document.querySelector<HTMLElement>('[data-testid="generated-image-preview-pane"]');
  return pane && !pane.closest("[inert]") ? pane : null;
}

export function setSnapshotSequenceFactory(value: typeof snapshotSequenceFactory) {
  snapshotSequenceFactory = value;
}

export function setAttachmentResponseDelayMs(value: typeof attachmentResponseDelayMs) {
  attachmentResponseDelayMs = value;
}

export function setAttachmentUploadSequence(value: typeof attachmentUploadSequence) {
  attachmentUploadSequence = value;
}

export function setAttachmentUploadBarrier(value: typeof attachmentUploadBarrier) {
  attachmentUploadBarrier = value;
}

export function setAttachmentCancelBarrier(value: typeof attachmentCancelBarrier) {
  attachmentCancelBarrier = value;
}

export function setFixture(value: typeof fixture) {
  fixture = value;
}

export function setDomainEventStream(value: typeof domainEventStream) {
  domainEventStream = value;
}

export function setThreadDetailSnapshotBarrier(value: typeof threadDetailSnapshotBarrier) {
  threadDetailSnapshotBarrier = value;
}

export function setMossCloudAccountStateOverride(value: typeof mossCloudAccountStateOverride) {
  mossCloudAccountStateOverride = value;
}

export function setComposerPredictionSuggestion(value: typeof composerPredictionSuggestion) {
  composerPredictionSuggestion = value;
}

/** The full-app fixture's suite hooks: call once at the top of each file's describe. */
export function installChatViewFixture() {
  const initializedFixtures = new WeakSet<object>();

  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async (context) => {
    // Mark before setup so a setup failure still receives teardown. Cases
    // assigned to another CI worker skip before entering this suite hook.
    initializedFixtures.add(context.task);
    // Every case starts without a remembered Canvas bundle (a session checks it once).
    resetEmbeddedBundleChecks();
    // Reset the shared fixture snapshot to a neutral, low-sequence shell before
    // disposing the old transport. Any in-flight getShellSnapshot that resolves
    // after this point will then return sequence 0, which the next test's real
    // snapshot will supersede.
    fixture = buildFixture({
      ...fixture.snapshot,
      snapshotSequence: 0,
      spaces: [],
      projects: [],
      threads: [],
      updatedAt: NOW_ISO,
    });
    await resetWsNativeApiForTest();
    realtimeVoiceChatHarness.webRtcConstructed.mockReset();
    realtimeVoiceChatHarness.webRtcDisposed.mockReset();
    realtimeVoiceChatHarness.webSocketConstructed.mockReset();
    realtimeVoiceChatHarness.webSocketDisposed.mockReset();
    resetRetainedThreadDetailSubscriptionsForTests();
    resetThreadDetailResumeCursors();
    await clearThreadDetailCache();
    await resetHomeChatProjectPrewarmStateForTests();
    attachmentResponseDelayMs = 0;
    threadDetailSnapshotBarrier = null;
    threadDetailSnapshotBarrierById.clear();
    attachmentUploadSequence = 0;
    attachmentUploadBarrier = null;
    attachmentCancelBarrier = null;
    localStorage.clear();
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: "en" }));
    // The realtime-voice pending launch lives in sessionStorage and survives draft
    // promotion by design; without a clear it would auto-start voice in the next test.
    sessionStorage.clear();
    // The theme store caches its snapshot and only refreshes inside storage-event
    // handlers (registered solely while a useTheme subscriber is mounted), so a bare
    // localStorage.clear() leaves a prior test's mode cached for the next mount.
    // Drop the cache and the applied class so each test starts on the default theme.
    resetThemeSnapshotCacheForTests();
    document.documentElement.classList.remove("dark");
    acknowledgeStartupAnnouncementsForTest(createBaseServerConfig());
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    useThreadDispatchStore.setState({ threads: {} });
    useLatestProjectStore.setState({ latestProjectId: null });
    useWorkspacePathsStore.setState({
      homeDir: null,
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      groupsWorkspaceRoot: null,
    });
    document.body.innerHTML = "";
    wsRequests.length = 0;
    composerPredictionSuggestion = null;
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
    localImageDownloadRequests.length = 0;
    useRightDockStore.setState({
      dockStateByThreadId: {},
    });
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      shellSnapshotSequence: 0,
      spaces: [],
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      threadDetailSyncById: {},
      threadDetailAppliedSequenceById: {},
      threadHistoryById: {},
      deletedProjectIdsById: {},
      deletedThreadIdsById: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
    useTemporaryThreadStore.setState({
      temporaryThreadIds: {},
    });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
    });
    useSplitViewStore.setState({
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
    });
    // The welcome tour's open state lives in a module store that outlives the unmounted app.
    // A case that opened it (or failed with it open) left its modal over every later mount,
    // so their clicks landed on the dialog's backdrop (red #958).
    useOnboardingDialogStore.setState({ isOpen: false, openReason: null, engaged: false });
  });

  afterEach(async (context) => {
    // Vitest calls afterEach even when the partition setup hook skipped a case.
    if (!initializedFixtures.delete(context.task)) return;
    await cleanup();
    await resetHomeChatProjectPrewarmStateForTests();
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });
}
