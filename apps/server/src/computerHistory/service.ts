import { execFile as execFileCallback } from "node:child_process";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  COMPUTER_HISTORY_MAX_QUERY_RESULTS,
  ComputerHistoryApplicationListResult,
  ComputerHistoryBrowserCapability,
  ComputerHistoryCaptureCapability,
  ComputerHistoryClearHistoryInput,
  ComputerHistoryClearHistoryResult,
  ComputerHistoryGetSettingsInput,
  ComputerHistoryGetStateInput,
  ComputerHistoryListHistoryInput,
  ComputerHistoryListHistoryResult,
  ComputerHistoryListSuggestionsInput,
  ComputerHistoryListSuggestionsResult,
  ComputerHistoryListSummaryIntervalsInput,
  ComputerHistoryListSummaryIntervalsResult,
  ComputerHistoryObservationSettings,
  ComputerHistoryRevealInFinderInput,
  ComputerHistoryRevealInFinderResult,
  ComputerHistoryResolveApplicationsInput,
  ComputerHistoryResolveApplicationsResult,
  ComputerHistorySetEnabledInput,
  ComputerHistorySettings,
  ComputerHistoryState,
  ComputerHistoryTimelineApplication,
  ComputerHistoryUpdateSettingsInput,
  type ComputerHistoryCaptureCandidate,
  type ComputerHistoryCaptureDecision,
  type ComputerHistoryApp,
  type ComputerHistoryBrowserCapability as ComputerHistoryBrowserCapabilityType,
  type ComputerHistoryObservation,
  type ComputerHistorySemanticSummary,
  type ComputerHistoryPermissionState,
  type ComputerHistoryTimelineEntry,
} from "@synara/contracts";
import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import {
  ComputerHistoryKeyProvider,
  COMPUTER_HISTORY_RETENTION_MS,
  EncryptedComputerHistoryAuditStore,
  EncryptedComputerHistoryStore,
  historyKeyFromBytes,
  normalizeComputerHistoryObservation,
  normalizeComputerHistorySemanticSummary,
  COMPUTER_HISTORY_MAX_APPLICATION_NAME_LENGTH,
  COMPUTER_HISTORY_MAX_ACTIVITY_TEXT_LENGTH,
  COMPUTER_HISTORY_MAX_BUNDLE_IDENTIFIER_LENGTH,
  COMPUTER_HISTORY_MAX_WINDOW_TITLE_LENGTH,
} from "./store.ts";
import {
  COMPUTER_HISTORY_SUGGESTION_WINDOW_MS,
  projectComputerHistory,
  type ComputerHistoryProjection,
} from "./summaryProjection.ts";
import {
  createComputerHistorySummaryJobEngine,
  toComputerHistorySafeSummaryInput,
  type ComputerHistorySummaryJobEngineOptions,
} from "./summaryJobs.ts";
import {
  removeComputerHistorySummaryJobResources,
  readComputerHistorySummaryJobManifest,
  resolveComputerHistorySummaryJobResourcePath,
  resolveComputerHistorySummaryPath,
  syncComputerHistorySummaryResources,
} from "./summaryResources.ts";

const execFile = promisify(execFileCallback);
const SETTINGS_FILENAME = "settings.json";
const RUNTIME_STATE_FILENAME = "runtime-state.json";
const MAX_PENDING_WRITES = 256;
const SUMMARY_RESOURCE_REFRESH_ERROR = "Computer History summary resources could not be refreshed.";
/** Keep native app icons small enough for a picker/timeline, not a media channel. */
export const COMPUTER_HISTORY_APP_ICON_MAX_DATA_URL_LENGTH = 192_000;
/** A catalog response is bounded even when a helper reports many applications. */
export const COMPUTER_HISTORY_APP_ICON_MAX_TOTAL_DATA_URL_LENGTH = 4 * 1024 * 1024;
export const COMPUTER_HISTORY_APPLICATION_MAX_COUNT = 500;
export const COMPUTER_HISTORY_APPLICATIONS_MAX_BUFFER = 8 * 1024 * 1024;
const COMPUTER_HISTORY_APPLICATION_DISCOVERY_TIMEOUT_MS = 5_000;
const COMPUTER_HISTORY_APP_ICON_PREFIX = "data:image/png;base64,";
const COMPUTER_HISTORY_PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

type ComputerHistoryApplicationMetadata = Pick<ComputerHistoryApp, "bundleIdentifier" | "name"> & {
  readonly iconDataURL?: string;
};

const DEFAULT_BROWSER_CAPABILITIES: ComputerHistoryBrowserCapability[] = [
  {
    bundleIdentifier: "com.google.Chrome",
    name: "Google Chrome",
    status: "supported",
    detail:
      "Verified active-tab and normal/incognito mode adapter; Automation permission is required.",
  },
  {
    bundleIdentifier: "com.google.Chrome.beta",
    name: "Google Chrome Beta",
    status: "supported",
    detail:
      "Verified active-tab and normal/incognito mode adapter; Automation permission is required.",
  },
  {
    bundleIdentifier: "com.google.Chrome.canary",
    name: "Google Chrome Canary",
    status: "supported",
    detail:
      "Verified active-tab and normal/incognito mode adapter; Automation permission is required.",
  },
  {
    bundleIdentifier: "com.google.Chrome.dev",
    name: "Google Chrome Dev",
    status: "supported",
    detail:
      "Verified active-tab and normal/incognito mode adapter; Automation permission is required.",
  },
  {
    bundleIdentifier: "com.apple.Safari",
    name: "Safari",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.apple.SafariTechnologyPreview",
    name: "Safari Technology Preview",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "org.mozilla.firefox",
    name: "Firefox",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "org.mozilla.firefoxdeveloperedition",
    name: "Firefox Developer Edition",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "org.mozilla.nightly",
    name: "Firefox Nightly",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "company.thebrowser.Browser",
    name: "Arc",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.microsoft.edgemac",
    name: "Microsoft Edge",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.microsoft.edgemac.Beta",
    name: "Microsoft Edge Beta",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.microsoft.edgemac.Canary",
    name: "Microsoft Edge Canary",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.microsoft.edgemac.Dev",
    name: "Microsoft Edge Dev",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
  {
    bundleIdentifier: "com.brave.Browser",
    name: "Brave Browser",
    status: "unsupported",
    detail: "No verified locale-independent private-window adapter is installed.",
  },
];
const CAPTURE_CAPABILITY: ComputerHistoryCaptureCapability = {
  mode: "window_metadata_only",
  interactionEvents: false,
  activitySummaries: false,
  detail:
    "Computer History validates one transient in-memory window frame after policy and target checks, but persists only bounded app/window metadata until a privacy-reviewed semantic summarizer is available. Keyboard, mouse, accessibility, URL, OCR text, and private-window data are never persisted.",
};
const HISTORY_SEMANTIC_CAPABILITY_DETAILS = {
  available: "Apple on-device semantic summaries are available.",
  device_not_eligible: "Apple on-device semantic summaries require an eligible device.",
  apple_intelligence_not_enabled: "Apple Intelligence is not enabled for on-device summaries.",
  model_not_ready: "The Apple on-device summary model is not ready.",
  unavailable: "Apple on-device semantic summaries are unavailable.",
} as const;
const HISTORY_SEMANTIC_CAPABILITY_STATUSES = new Set<
  keyof typeof HISTORY_SEMANTIC_CAPABILITY_DETAILS
>(
  Object.keys(HISTORY_SEMANTIC_CAPABILITY_DETAILS) as Array<
    keyof typeof HISTORY_SEMANTIC_CAPABILITY_DETAILS
  >,
);
const KNOWN_BROWSER_BUNDLE_IDENTIFIERS = new Set(
  DEFAULT_BROWSER_CAPABILITIES.map((capability) => capability.bundleIdentifier),
);

const DEFAULT_OBSERVATION_SETTINGS: ComputerHistoryObservationSettings = {
  defaultApplicationBehavior: "allow",
  defaultURLBehavior: "allow",
  allowlist: [],
  blocklist: [],
  urlAllowlist: [],
  urlBlocklist: [],
};

export const DEFAULT_COMPUTER_HISTORY_SETTINGS: ComputerHistorySettings = {
  observation: DEFAULT_OBSERVATION_SETTINGS,
  consentAt: null,
};

const KEYCHAIN_NAMESPACE_PATTERN = /^[a-z0-9-]{1,80}$/;

function validateKeychainNamespace(namespace: string | undefined): string {
  if (!namespace || !KEYCHAIN_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error("Computer History requires a bounded Keychain namespace.");
  }
  return namespace;
}

async function readHelperKey(
  helperPath: string,
  operation: "get" | "create",
  keychainNamespace: string,
): Promise<Buffer> {
  const result = await execFile(
    helperPath,
    [`--history-keychain-${operation}`, "--history-keychain-namespace", keychainNamespace],
    {
      maxBuffer: 16 * 1024,
    },
  );
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "history_key" && typeof message.key === "string") {
      return historyKeyFromBytes(Buffer.from(message.key, "base64"));
    }
  }
  throw new Error("Computer History helper did not return a Keychain key.");
}

function normalizeHistoryAppIcon(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > COMPUTER_HISTORY_APP_ICON_MAX_DATA_URL_LENGTH) {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    !trimmed.startsWith(COMPUTER_HISTORY_APP_ICON_PREFIX) ||
    trimmed.length > COMPUTER_HISTORY_APP_ICON_MAX_DATA_URL_LENGTH
  ) {
    return undefined;
  }
  const payload = trimmed.slice(COMPUTER_HISTORY_APP_ICON_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return undefined;
  const bytes = Buffer.from(payload, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > 128_000 ||
    bytes.toString("base64") !== payload ||
    !bytes.subarray(0, COMPUTER_HISTORY_PNG_SIGNATURE.length).equals(COMPUTER_HISTORY_PNG_SIGNATURE)
  ) {
    return undefined;
  }
  return trimmed;
}

async function readHelperApplications(
  helperPath: string,
): Promise<ComputerHistoryApplicationMetadata[]> {
  const result = await execFile(helperPath, ["--history-applications"], {
    maxBuffer: COMPUTER_HISTORY_APPLICATIONS_MAX_BUFFER,
    timeout: COMPUTER_HISTORY_APPLICATION_DISCOVERY_TIMEOUT_MS,
  });
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type !== "history_applications" || !Array.isArray(message.applications)) continue;
    let iconDataURLCharacters = 0;
    return message.applications
      .slice(0, COMPUTER_HISTORY_APPLICATION_MAX_COUNT)
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const candidate = value as Record<string, unknown>;
        if (
          typeof candidate.bundleIdentifier !== "string" ||
          typeof candidate.name !== "string" ||
          candidate.bundleIdentifier.trim() === "" ||
          candidate.name.trim() === ""
        ) {
          return [];
        }
        const iconDataURL = normalizeHistoryAppIcon(candidate.iconDataURL);
        if (
          iconDataURL &&
          iconDataURLCharacters + iconDataURL.length >
            COMPUTER_HISTORY_APP_ICON_MAX_TOTAL_DATA_URL_LENGTH
        ) {
          return [
            {
              bundleIdentifier: candidate.bundleIdentifier.trim(),
              name: candidate.name.trim(),
            },
          ];
        }
        if (iconDataURL) iconDataURLCharacters += iconDataURL.length;
        return [
          {
            bundleIdentifier: candidate.bundleIdentifier.trim(),
            name: candidate.name.trim(),
            ...(iconDataURL ? { iconDataURL } : {}),
          },
        ];
      });
  }
  return [];
}

function defaultKeyProvider(
  helperPath?: string,
  keychainNamespace?: string,
): ComputerHistoryKeyProvider {
  const namespace = helperPath ? validateKeychainNamespace(keychainNamespace) : undefined;
  return {
    async getOrCreateKey() {
      if (process.platform !== "darwin" || !helperPath) {
        throw new Error("The native Computer History Keychain helper is unavailable.");
      }
      try {
        return await readHelperKey(helperPath, "get", namespace!);
      } catch {
        return readHelperKey(helperPath, "create", namespace!);
      }
    },
    async destroyKey() {
      if (process.platform !== "darwin" || !helperPath) return;
      const boundedNamespace = validateKeychainNamespace(namespace);
      await execFile(
        helperPath,
        ["--history-keychain-destroy", "--history-keychain-namespace", boundedNamespace],
        { maxBuffer: 16 * 1024 },
      );
    },
  };
}

function cloneSettings(settings: ComputerHistorySettings): ComputerHistorySettings {
  return {
    consentAt: settings.consentAt,
    observation: {
      defaultApplicationBehavior: settings.observation.defaultApplicationBehavior,
      defaultURLBehavior: settings.observation.defaultURLBehavior,
      allowlist: [...settings.observation.allowlist],
      blocklist: [...settings.observation.blocklist],
      urlAllowlist: [...settings.observation.urlAllowlist],
      urlBlocklist: [...settings.observation.urlBlocklist],
    },
  };
}

function normalizeHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Normalize helper activity text before the encrypted-store bounds checks run. */
function sanitizeHistoryActivityText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length > 0 ? "[redacted activity]" : undefined;
}

function normalizeRule(value: string): string {
  return value.trim().toLowerCase();
}

function isAllowed(
  value: string,
  defaultBehavior: "allow" | "block",
  allowlist: readonly string[],
  blocklist: readonly string[],
): boolean {
  const normalized = normalizeRule(value);
  if (blocklist.some((rule) => normalizeRule(rule) === normalized)) return false;
  if (defaultBehavior === "block") {
    return allowlist.some((rule) => normalizeRule(rule) === normalized);
  }
  // In allow-all mode the editable rule set is an exclusion list. An
  // allowlist is intentionally ignored here so that switching from
  // deny-all/include-only to allow-all/exclude-only cannot accidentally keep
  // the previous include-only semantics.
  return true;
}

function parseSettings(value: unknown): ComputerHistorySettings {
  if (value === null || typeof value !== "object")
    throw new Error("Invalid Computer History settings.");
  const record = value as Partial<ComputerHistorySettings>;
  const observation = record.observation;
  if (
    !observation ||
    typeof observation !== "object" ||
    (observation.defaultApplicationBehavior !== "allow" &&
      observation.defaultApplicationBehavior !== "block") ||
    (observation.defaultURLBehavior !== "allow" && observation.defaultURLBehavior !== "block") ||
    !Array.isArray(observation.allowlist) ||
    !Array.isArray(observation.blocklist) ||
    !Array.isArray(observation.urlAllowlist) ||
    !Array.isArray(observation.urlBlocklist) ||
    observation.allowlist.some((item) => typeof item !== "string") ||
    observation.blocklist.some((item) => typeof item !== "string") ||
    observation.urlAllowlist.some((item) => typeof item !== "string") ||
    observation.urlBlocklist.some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid Computer History observation settings.");
  }
  return {
    consentAt: typeof record.consentAt === "string" ? record.consentAt : null,
    observation: {
      defaultApplicationBehavior: observation.defaultApplicationBehavior,
      defaultURLBehavior: observation.defaultURLBehavior,
      allowlist: observation.allowlist.map(String),
      blocklist: observation.blocklist.map(String),
      urlAllowlist: observation.urlAllowlist.map(String),
      urlBlocklist: observation.urlBlocklist.map(String),
    },
  };
}

export interface ComputerHistoryServiceOptions {
  readonly rootDir: string;
  readonly supported?: boolean;
  readonly helperPath?: string;
  /** Non-secret digest label shared by WS and Agent Gateway for one runtime. */
  readonly keychainNamespace?: string;
  readonly keyProvider?: ComputerHistoryKeyProvider;
  readonly now?: () => number;
  /** Local deterministic injection used by focused service tests; production
   * leaves the recursive engine on its built-in backend. */
  readonly summaryJobOptions?: Pick<
    ComputerHistorySummaryJobEngineOptions,
    "backend" | "sleep" | "setTimer" | "clearTimer" | "backendTimeoutMs" | "randomAlpha"
  >;
  /** Test/desktop injection point; production defaults to Finder's open -R. */
  readonly revealInFinder?: (path: string) => Promise<void> | void;
  readonly permissions?: Partial<{
    inputMonitoring: ComputerHistoryPermissionState;
    accessibility: ComputerHistoryPermissionState;
    screenRecording: ComputerHistoryPermissionState;
  }>;
}

/**
 * The helper's candidate/final wire payload is intentionally broader than the
 * persisted observation. URL and private mode are policy-only fields and are
 * consumed before the safe observation is rebuilt.
 */
type HistoryCaptureCandidate = ComputerHistoryCaptureCandidate & {
  readonly receivedAtMs: number;
};

type HistoryCaptureReceipt = HistoryCaptureCandidate & {
  readonly expiresAtMs: number;
  consumed: boolean;
};

// The helper's semantic lane has a 3s caller deadline. Keep this receipt
// strictly longer so a completed bounded request is not rejected at the wire.
const HISTORY_CAPTURE_RECEIPT_TIMEOUT_MS = 15_000;
const HISTORY_CAPTURE_ID_MAX_LENGTH = 128;
const HISTORY_CAPTURE_FINGERPRINT_MAX_LENGTH = 2_048;
const HISTORY_CAPTURE_URL_MAX_LENGTH = 4_096;
const HISTORY_CAPTURE_RECEIPT_LIMIT = 64;
const HISTORY_HELPER_LINE_MAX_BYTES = COMPUTER_HISTORY_APPLICATIONS_MAX_BUFFER;

type ComputerHistoryRecordInput = {
  readonly capturedAtMs: number;
  readonly app: { readonly bundleIdentifier: string; readonly name: string };
  readonly window: { readonly title?: string; readonly url?: string };
  readonly activityText?: string;
  readonly semanticSummary?: ComputerHistorySemanticSummary;
  /** Legacy/transient input only; never enters the persisted observation. */
  readonly privateBrowsing?: boolean;
};

export interface ComputerHistoryService {
  readonly getState: (input?: ComputerHistoryGetStateInput) => Promise<ComputerHistoryState>;
  readonly getSettings: (
    input?: ComputerHistoryGetSettingsInput,
  ) => Promise<ComputerHistorySettings>;
  readonly updateSettings: (
    input: ComputerHistoryUpdateSettingsInput,
  ) => Promise<ComputerHistoryState>;
  readonly listApplications: () => Promise<ComputerHistoryApplicationListResult>;
  readonly resolveApplications: (
    input: ComputerHistoryResolveApplicationsInput,
  ) => Promise<ComputerHistoryResolveApplicationsResult>;
  readonly setEnabled: (input: ComputerHistorySetEnabledInput) => Promise<ComputerHistoryState>;
  readonly retryActivation: () => Promise<ComputerHistoryState>;
  readonly pause: () => Promise<ComputerHistoryState>;
  readonly resume: () => Promise<ComputerHistoryState>;
  readonly listHistory: (
    input?: ComputerHistoryListHistoryInput,
  ) => Promise<ComputerHistoryListHistoryResult>;
  readonly listHistorySuggestions: (
    input?: ComputerHistoryListSuggestionsInput,
  ) => Promise<ComputerHistoryListSuggestionsResult>;
  readonly listHistorySummaryIntervals: (
    input: ComputerHistoryListSummaryIntervalsInput,
  ) => Promise<ComputerHistoryListSummaryIntervalsResult>;
  readonly revealInFinder: (
    input: ComputerHistoryRevealInFinderInput,
  ) => Promise<ComputerHistoryRevealInFinderResult>;
  readonly clearHistory: (
    input: ComputerHistoryClearHistoryInput,
  ) => Promise<ComputerHistoryClearHistoryResult>;
  readonly recordObservation: (observation: ComputerHistoryRecordInput) => Promise<boolean>;
  readonly recordAccessAudit: (input: {
    readonly tool: "history_status" | "history_query";
    readonly callerThreadId: string;
    readonly callerProvider: string;
    readonly resultCount?: number;
  }) => Promise<void>;
}

export function makeComputerHistoryService(
  options: ComputerHistoryServiceOptions,
): ComputerHistoryService {
  const now = options.now ?? Date.now;
  const supported =
    options.supported ?? (process.platform === "darwin" && options.helperPath !== undefined);
  const keyProvider =
    options.keyProvider ?? defaultKeyProvider(options.helperPath, options.keychainNamespace);
  const store = new EncryptedComputerHistoryStore(options.rootDir, keyProvider);
  const auditStore = new EncryptedComputerHistoryAuditStore(options.rootDir, keyProvider);
  const summaryJobEngine = createComputerHistorySummaryJobEngine({
    ...options.summaryJobOptions,
    rootDir: options.rootDir,
    now,
    onRunResult: (result) => {
      summaryJobRefreshFailed = result.failedJobKeys.length > 0;
      if (summaryJobRefreshFailed) {
        lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
      } else if (lastError === SUMMARY_RESOURCE_REFRESH_ERROR) {
        lastError = null;
      }
    },
    onRunError: (error) => {
      // Stop/pause intentionally abort an in-flight run. Only a live refresh
      // failure should be surfaced as a service health error.
      if ((error as { name?: unknown })?.name === "AbortError" && recorderState !== "running") {
        return;
      }
      summaryJobRefreshFailed = true;
      lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
    },
  });
  const settingsPath = join(options.rootDir, SETTINGS_FILENAME);
  const runtimeStatePath = join(options.rootDir, RUNTIME_STATE_FILENAME);
  let settings: ComputerHistorySettings = cloneSettings(DEFAULT_COMPUTER_HISTORY_SETTINGS);
  let settingsLoaded = false;
  let runtimeStateLoaded = false;
  let settingsLoadPromise: Promise<void> | undefined;
  let enabled = false;
  let recorderState: ComputerHistoryState["recorderState"] = "stopped";
  let activationState: ComputerHistoryState["activationState"] = "idle";
  let lastError: string | null = null;
  let droppedEvents = 0;
  let queueDepth = 0;
  let keychainState: "ready" | "locked" | "unavailable" | "unknown" = "unknown";
  let privacyDecisionEnforced = false;
  let semanticSummaryCapabilityAvailable = false;
  let summaryJobRefreshFailed = false;
  let validatedRecursiveResources = new Map<
    string,
    { readonly logicalJobKey: string; readonly path: string }
  >();
  let browserCapabilities = DEFAULT_BROWSER_CAPABILITIES.map((capability) => ({ ...capability }));
  let permissionState = {
    inputMonitoring: options.permissions?.inputMonitoring ?? (supported ? "pending" : "unknown"),
    accessibility: options.permissions?.accessibility ?? (supported ? "pending" : "unknown"),
    screenRecording: options.permissions?.screenRecording ?? (supported ? "pending" : "unknown"),
  } satisfies {
    inputMonitoring: ComputerHistoryPermissionState;
    accessibility: ComputerHistoryPermissionState;
    screenRecording: ComputerHistoryPermissionState;
  };
  let loadPromise: Promise<void> | undefined;
  let storeOperationChain: Promise<void> = Promise.resolve();
  let activationPromise: Promise<void> | undefined;
  let runtimeWriteChain: Promise<void> = Promise.resolve();
  let historyHelper: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let historyHelperGeneration = 0;
  const captureReceipts = new Map<string, HistoryCaptureReceipt>();
  let applicationDiscoveryAttempted = false;
  let applicationDiscoveryPromise: Promise<void> | undefined;
  const applicationCatalog = new Map<string, ComputerHistoryApplicationMetadata>();
  const applicationDiscoveryOrder = new Map<string, number>();

  // Browser-ness is a capability-registry fact, never a display-name guess.
  // The native helper may add or replace routes at runtime; keep those IDs in
  // the same registry used by the privacy gate and application metadata.
  const isWebBrowserBundle = (bundleIdentifier: string): boolean =>
    KNOWN_BROWSER_BUNDLE_IDENTIFIERS.has(bundleIdentifier) ||
    browserCapabilities.some((capability) => capability.bundleIdentifier === bundleIdentifier);

  const cacheApplication = (application: ComputerHistoryApplicationMetadata): void => {
    const previous = applicationCatalog.get(application.bundleIdentifier);
    let iconDataURL = application.iconDataURL ?? previous?.iconDataURL;
    if (application.iconDataURL && application.iconDataURL !== previous?.iconDataURL) {
      const currentIconCharacters = [...applicationCatalog.values()].reduce(
        (total, value) => total + (value.iconDataURL?.length ?? 0),
        0,
      );
      const previousIconCharacters = previous?.iconDataURL?.length ?? 0;
      if (
        currentIconCharacters - previousIconCharacters + application.iconDataURL.length >
        COMPUTER_HISTORY_APP_ICON_MAX_TOTAL_DATA_URL_LENGTH
      ) {
        iconDataURL = previous?.iconDataURL;
      }
    }
    applicationCatalog.set(application.bundleIdentifier, {
      name: application.name,
      ...(iconDataURL ? { iconDataURL } : {}),
      bundleIdentifier: application.bundleIdentifier,
    });
  };

  const ensureApplicationCatalog = async (): Promise<void> => {
    if (applicationDiscoveryPromise) return applicationDiscoveryPromise;
    const helperPath = options.helperPath;
    if (applicationDiscoveryAttempted || !helperPath || !supported) return;
    applicationDiscoveryAttempted = true;
    const discovery = (async () => {
      try {
        const discoveredApplications = await readHelperApplications(helperPath);
        for (const [index, application] of discoveredApplications.entries()) {
          applicationDiscoveryOrder.set(application.bundleIdentifier, index);
          cacheApplication(application);
        }
      } catch {
        // Discovery is bounded and fail-closed: an unavailable helper yields the
        // previously observed catalog. The attempt remains single-shot so a
        // broken helper cannot stall every timeline refresh.
      }
    })();
    applicationDiscoveryPromise = discovery;
    try {
      await discovery;
    } finally {
      if (applicationDiscoveryPromise === discovery) applicationDiscoveryPromise = undefined;
    }
  };

  const loadSettings = async (): Promise<void> => {
    if (settingsLoaded && runtimeStateLoaded) return;
    if (settingsLoadPromise) return settingsLoadPromise;
    settingsLoadPromise = (async () => {
      if (!settingsLoaded) {
        try {
          const raw = await readFile(settingsPath, "utf8");
          settings = parseSettings(JSON.parse(raw));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // Invalid settings fail closed: leave the recorder off and require
            // the user to explicitly save a valid policy again.
            settings = {
              observation: {
                defaultApplicationBehavior: "block",
                defaultURLBehavior: "block",
                allowlist: [],
                blocklist: [],
                urlAllowlist: [],
                urlBlocklist: [],
              },
              consentAt: null,
            };
            lastError = "Computer History settings could not be read.";
          }
        }
        settingsLoaded = true;
      }
      if (runtimeStateLoaded) return;
      try {
        const raw = await readFile(runtimeStatePath, "utf8");
        const value = JSON.parse(raw) as {
          enabled?: unknown;
          recorderState?: unknown;
        };
        if (value.enabled === true) {
          enabled = true;
          recorderState = value.recorderState === "paused" ? "paused" : "stopped";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          lastError = "Computer History runtime state could not be read.";
          enabled = false;
          recorderState = "stopped";
        }
      }
      runtimeStateLoaded = true;
    })();
    try {
      await settingsLoadPromise;
    } finally {
      settingsLoadPromise = undefined;
    }
  };

  const ensureLoadedUnsafe = async (): Promise<void> => {
    await loadSettings();
    if (!loadPromise) {
      loadPromise = Promise.all([store.reload(), auditStore.reload()])
        .then(async () => {
          await auditStore.prune(now());
        })
        .catch((error) => {
          keychainState = "unavailable";
          lastError = "Computer History encrypted state could not be authenticated.";
          activationState = "failed";
          throw error;
        })
        .finally(() => {
          loadPromise = undefined;
        });
    }
    await loadPromise;
    for (const record of store.loadedRecords) cacheApplication(record.observation.app);
    const retentionSince = Math.max(0, now() - COMPUTER_HISTORY_RETENTION_MS);
    const safeInputs = store.loadedRecords.flatMap(({ observation }) => {
      if (
        !Number.isSafeInteger(observation.capturedAtMs) ||
        observation.capturedAtMs < retentionSince
      ) {
        return [];
      }
      try {
        return [toComputerHistorySafeSummaryInput(observation)];
      } catch {
        // One malformed legacy record must not poison valid history inputs.
        return [];
      }
    });
    summaryJobEngine.replaceInputs(safeInputs);
    if (summaryJobEngine.hasPendingInputReplacement()) {
      // Hydration that changes the source graph revokes recursive
      // addressability until a scheduler/catch-up publishes the replacement.
      summaryJobEngine.invalidatePublishedResources();
    }
  };

  const runStoreOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = storeOperationChain.then(async () => {
      await ensureLoadedUnsafe();
      return operation();
    });
    storeOperationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const recordAccessAudit = async (input: {
    readonly tool: "history_status" | "history_query";
    readonly callerThreadId: string;
    readonly callerProvider: string;
    readonly resultCount?: number;
  }): Promise<void> => {
    await runStoreOperation(async () => {
      await auditStore.append({
        atMs: now(),
        tool: input.tool,
        callerThreadId: input.callerThreadId.slice(0, 200),
        callerProvider: input.callerProvider.slice(0, 100),
        ...(input.resultCount === undefined
          ? {}
          : { resultCount: Math.max(0, Math.floor(input.resultCount)) }),
      });
    });
  };

  const ensureLoaded = async (): Promise<void> => {
    await runStoreOperation(async () => undefined);
  };

  const restoreRuntimeIfNeeded = async (): Promise<void> => {
    await loadSettings();
    // A persisted running session resumes only after the encrypted store has
    // authenticated. A persisted pause remains off until the user resumes.
    if (enabled && recorderState === "stopped" && activationState === "idle" && !historyHelper) {
      if (!activationPromise) {
        activationPromise = activate().finally(() => {
          activationPromise = undefined;
        });
      }
      await activationPromise;
    }
  };

  const persistSettings = async (): Promise<void> => {
    await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
    await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, settingsPath));
  };

  const persistRuntimeState = async (): Promise<void> => {
    const write = runtimeWriteChain.then(async () => {
      await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
      await Effect.runPromise(
        writeFileStringAtomically({
          filePath: runtimeStatePath,
          contents: `${JSON.stringify({ enabled, recorderState })}\n`,
          mode: 0o600,
        }),
      );
    });
    runtimeWriteChain = write.catch(() => undefined);
    await write;
  };

  const buildState = (): ComputerHistoryState => ({
    supported,
    enabled,
    recorderState,
    activationState,
    inputMonitoringPermission: permissionState.inputMonitoring,
    accessibilityPermission: permissionState.accessibility,
    screenRecordingPermission: permissionState.screenRecording,
    // The claim is true only while capture is off (there is no capture to
    // exclude) or while the helper is alive. If a custom/test source has no
    // helper, the recorder remains unable to claim browser private-mode
    // detection and exposes false rather than silently claiming parity.
    privateBrowsingExcluded:
      !enabled || recorderState === "paused" || !supported || privacyDecisionEnforced,
    browserCapabilities: (supported
      ? browserCapabilities
      : browserCapabilities.map((capability) => ({
          ...capability,
          status: "unsupported" as const,
          detail: "Computer History is unavailable on this platform.",
        }))
    ).map((capability) => ({ ...capability })),
    captureCapability: {
      mode:
        supported && semanticSummaryCapabilityAvailable
          ? "interaction_activity"
          : CAPTURE_CAPABILITY.mode,
      interactionEvents: false,
      activitySummaries: supported && semanticSummaryCapabilityAvailable,
      detail:
        supported && semanticSummaryCapabilityAvailable
          ? "Computer History uses one privacy-authorized in-memory frame and Apple's on-device structured semantic summarizer; raw OCR and private-window data are never persisted."
          : CAPTURE_CAPABILITY.detail,
    },
    settings: cloneSettings(settings),
    health: {
      droppedEvents,
      queueDepth,
      storageBytes: 0,
      lastError,
      corruptionDetected: store.isCorrupt || auditStore.isCorrupt,
      keychainState: store.isCorrupt || auditStore.isCorrupt ? "unavailable" : keychainState,
    },
    message: !supported
      ? "Computer History is available only in the macOS desktop app with the history helper."
      : lastError,
  });

  const stateWithStorage = async (): Promise<ComputerHistoryState> => {
    const state = buildState();
    const [historyBytes, auditBytes] = await Promise.all([
      store.sizeBytes(),
      auditStore.sizeBytes(),
    ]);
    return {
      ...state,
      health: { ...state.health, storageBytes: historyBytes + auditBytes },
    };
  };

  const projectHistory = (
    input: {
      readonly sinceMs?: number;
      readonly untilMs?: number;
      readonly limit?: number;
    } = {},
  ): ComputerHistoryProjection => {
    const currentNow = now();
    const retentionSince = Math.max(0, currentNow - COMPUTER_HISTORY_RETENTION_MS);
    const retainedRecords = store.loadedRecords.filter(
      ({ observation }) => observation.capturedAtMs >= retentionSince,
    );
    return projectComputerHistory(retainedRecords, {
      nowMs: currentNow,
      sinceMs: Math.max(retentionSince, input.sinceMs ?? 0),
      ...(input.untilMs === undefined ? {} : { untilMs: input.untilMs }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      applicationCatalog,
    });
  };

  const overlayRecursiveProjection = (
    projection: ComputerHistoryProjection,
    recursiveResources: ReadonlyMap<
      string,
      { readonly logicalJobKey: string; readonly path: string }
    >,
  ): ComputerHistoryProjection => {
    const recursiveByKey = new Map(
      summaryJobEngine.snapshot().map((summary) => [summary.logicalJobKey, summary]),
    );
    const overlayResource = (resource: ComputerHistoryProjection["resources"][number]) => {
      // The projection resource is the source of truth for optional
      // suggestions. Keep the suggestion attached to the timeline entry even
      // when the recursive summary is not yet materialized.
      const resourceWithSuggestion = resource.suggestion
        ? {
            ...resource,
            entry: { ...resource.entry, suggestion: resource.suggestion },
          }
        : resource;
      const kind = resource.kind === "6h" ? "6h" : "10min";
      const logicalJobKey = `${kind}:${resource.startMs}`;
      const summary = recursiveByKey.get(logicalJobKey);
      const validated = recursiveResources.get(resource.entryId);
      if (!summary || !validated || validated.logicalJobKey !== summary.logicalJobKey) {
        return resourceWithSuggestion;
      }
      const applications: ComputerHistoryTimelineApplication[] =
        summary.applicationBundleIdentifiers.map((bundleIdentifier, index) => {
          const catalogEntry = applicationCatalog.get(bundleIdentifier);
          const displayName = catalogEntry?.name ?? summary.applications[index] ?? bundleIdentifier;
          return {
            bundleIdentifier,
            displayName,
            ...(catalogEntry?.iconDataURL ? { iconDataURL: catalogEntry.iconDataURL } : {}),
          };
        });
      const safeApplications = applications.length > 0 ? applications : resource.entry.applications;
      return {
        ...resource,
        title: summary.title,
        description: summary.description,
        summaryText: summary.summaryText,
        applications: safeApplications.map((application) => application.displayName),
        applicationBundleIdentifiers: safeApplications.map(
          (application) => application.bundleIdentifier,
        ),
        entry: {
          ...resourceWithSuggestion.entry,
          title: summary.title,
          description: summary.description,
          applications: safeApplications,
        },
      };
    };
    const resources = projection.resources.map(overlayResource);
    const resourcesByEntryId = new Map(resources.map((resource) => [resource.entryId, resource]));
    const entries = projection.entries.map(
      (entry) => resourcesByEntryId.get(entry.id)?.entry ?? entry,
    );
    const intervals = projection.intervals.map((interval) => {
      const resource = resources.find(
        (candidate) =>
          (candidate.kind === interval.kind ||
            (candidate.kind === "10min" && interval.kind === "10min") ||
            (candidate.kind === "6h" && interval.kind === "6h")) &&
          candidate.startMs === interval.startMs,
      );
      return resource ? { ...interval, summary: resource.summaryText } : interval;
    });
    return { ...projection, entries, intervals, resources };
  };

  const syncHistoryResources = async (): Promise<ReadonlyMap<string, string>> => {
    validatedRecursiveResources = new Map();
    if (enabled && recorderState === "running" && summaryJobEngine.state() === "stopped") {
      try {
        await summaryJobEngine.start({ catchUp: true });
      } catch {
        lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
        summaryJobRefreshFailed = true;
      }
    }
    const projection = projectHistory();
    const paths = new Map(
      await syncComputerHistorySummaryResources(options.rootDir, projection.resources),
    );
    const jobPaths = summaryJobEngine.resourcePaths();
    const manifestFiles = await readComputerHistorySummaryJobManifest(options.rootDir);
    for (const resource of projection.resources) {
      const kind = resource.kind === "6h" ? "6h" : "10min";
      const logicalJobKey = `${kind}:${resource.startMs}`;
      const publishedPath = jobPaths.get(`${kind}:${resource.startMs}`);
      const publishedFilename = publishedPath ? basename(publishedPath) : undefined;
      if (!publishedFilename || manifestFiles.get(logicalJobKey) !== publishedFilename) continue;
      const jobPath = publishedPath
        ? resolveComputerHistorySummaryJobResourcePath(options.rootDir, publishedFilename)
        : null;
      if (jobPath) {
        try {
          const metadata = await lstat(jobPath);
          if (metadata.isFile() && !metadata.isSymbolicLink()) {
            paths.set(resource.entryId, jobPath);
            validatedRecursiveResources.set(resource.entryId, {
              logicalJobKey,
              path: jobPath,
            });
          }
        } catch {
          // A deleted/replaced recursive file is never returned to UI, model,
          // or Finder; the safe legacy projection remains the fallback.
        }
      }
    }
    if (lastError === SUMMARY_RESOURCE_REFRESH_ERROR && !summaryJobRefreshFailed) {
      lastError = null;
    }
    return paths;
  };

  const activate = async (): Promise<void> => {
    if (!supported) {
      activationState = "failed";
      recorderState = "stopped";
      await persistRuntimeState();
      lastError = "Computer History is unavailable on this platform.";
      return;
    }
    activationState = "starting";
    lastError = null;
    try {
      await runStoreOperation(async () => {
        await store.ensureKey();
      });
      keychainState = "ready";
      startHistoryHelper();
      if (permissionState.screenRecording !== "granted") {
        activationState = "waiting_for_permissions";
        recorderState = "stopped";
        await persistRuntimeState();
        return;
      }
      activationState = "idle";
      recorderState = "running";
      try {
        await summaryJobEngine.start({ catchUp: true });
      } catch {
        lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
        summaryJobRefreshFailed = true;
      }
      await persistRuntimeState();
    } catch {
      keychainState = "unavailable";
      activationState = "failed";
      recorderState = "stopped";
      await persistRuntimeState();
      lastError = "Computer History could not access its Keychain key.";
    }
  };

  const stopHistoryHelper = (): void => {
    captureReceipts.clear();
    historyHelperGeneration += 1;
    semanticSummaryCapabilityAvailable = false;
    void summaryJobEngine.stop();
    if (!historyHelper) return;
    historyHelper.kill();
    historyHelper = null;
  };

  const protocolString = (value: unknown, maxLength: number): string | null =>
    typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
      ? value
      : null;

  const parseCaptureCandidate = (
    message: Record<string, unknown>,
  ): HistoryCaptureCandidate | null => {
    if (message.type !== "history_capture_candidate") return null;
    const candidateKeys = new Set([
      "type",
      "requestId",
      "fingerprint",
      "app",
      "window",
      "privateBrowsing",
      "browserMode",
    ]);
    if (Object.keys(message).some((key) => !candidateKeys.has(key))) return null;
    const requestId = protocolString(message.requestId, HISTORY_CAPTURE_ID_MAX_LENGTH);
    const fingerprint =
      typeof message.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(message.fingerprint)
        ? message.fingerprint
        : null;
    const app = message.app;
    const window = message.window;
    if (
      !requestId ||
      !fingerprint ||
      !app ||
      typeof app !== "object" ||
      Array.isArray(app) ||
      !window ||
      typeof window !== "object" ||
      Array.isArray(window) ||
      typeof (app as Record<string, unknown>).bundleIdentifier !== "string" ||
      typeof (app as Record<string, unknown>).name !== "string" ||
      typeof message.privateBrowsing !== "boolean"
    ) {
      return null;
    }
    const appRecord = app as Record<string, unknown>;
    const windowRecord = window as Record<string, unknown>;
    if (
      Object.keys(appRecord).some((key) => key !== "bundleIdentifier" && key !== "name") ||
      Object.keys(windowRecord).some((key) => key !== "title" && key !== "url")
    ) {
      return null;
    }
    const bundleIdentifier = protocolString(
      appRecord.bundleIdentifier,
      COMPUTER_HISTORY_MAX_BUNDLE_IDENTIFIER_LENGTH,
    );
    const name = protocolString(appRecord.name, COMPUTER_HISTORY_MAX_APPLICATION_NAME_LENGTH);
    const title =
      windowRecord.title === undefined
        ? undefined
        : protocolString(windowRecord.title, COMPUTER_HISTORY_MAX_WINDOW_TITLE_LENGTH);
    const url =
      windowRecord.url === undefined
        ? undefined
        : protocolString(windowRecord.url, HISTORY_CAPTURE_URL_MAX_LENGTH);
    const browserMode = message.browserMode;
    if (
      !bundleIdentifier ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/u.test(bundleIdentifier) ||
      !name ||
      (windowRecord.title !== undefined && title === null) ||
      (windowRecord.url !== undefined && url === null) ||
      (browserMode !== undefined && browserMode !== "normal" && browserMode !== "incognito")
    ) {
      return null;
    }
    return {
      type: "history_capture_candidate",
      requestId,
      fingerprint,
      app: { bundleIdentifier, name },
      window: {
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof url === "string" ? { url } : {}),
      },
      privateBrowsing: message.privateBrowsing,
      ...(browserMode === undefined ? {} : { browserMode }),
      receivedAtMs: now(),
    };
  };

  const sendCaptureDecision = (
    child: ChildProcessByStdio<Writable, Readable, null>,
    candidate: HistoryCaptureCandidate,
    allow: boolean,
  ): void => {
    const decision: ComputerHistoryCaptureDecision = {
      type: "history_capture_decision",
      requestId: candidate.requestId,
      fingerprint: candidate.fingerprint,
      allow,
    };
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(decision)}\n`, () => undefined);
    }
  };

  const startHistoryHelper = (): void => {
    if (!options.helperPath || historyHelper || !supported) return;
    semanticSummaryCapabilityAvailable = false;
    const generation = historyHelperGeneration + 1;
    historyHelperGeneration = generation;
    try {
      const child = spawn(options.helperPath, ["--history-watch"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, MOSS_HISTORY_WATCH: "1" },
      });
      historyHelper = child;
      child.stdin.on("error", () => {
        // A helper can exit between a policy decision and the write. The
        // receipt is discarded by the exit handler; never surface EPIPE.
      });
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (historyHelper !== child || historyHelperGeneration !== generation) return;
        pending += chunk.toString("utf8");
        if (Buffer.byteLength(pending, "utf8") > HISTORY_HELPER_LINE_MAX_BYTES) {
          pending = "";
          captureReceipts.clear();
          semanticSummaryCapabilityAvailable = false;
          if (historyHelper === child && historyHelperGeneration === generation) {
            historyHelper = null;
            historyHelperGeneration += 1;
          }
          child.kill();
          activationState = "failed";
          recorderState = "stopped";
          lastError = "Computer History helper protocol line exceeded its safety limit.";
          void persistRuntimeState();
          return;
        }
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.type === "history_semantic_capability") {
              const capabilityKeys = new Set(["type", "status", "detail"]);
              const status = message.status;
              const detail = message.detail;
              const validStatus =
                typeof status === "string" &&
                HISTORY_SEMANTIC_CAPABILITY_STATUSES.has(
                  status as keyof typeof HISTORY_SEMANTIC_CAPABILITY_DETAILS,
                );
              const validDetail =
                typeof status === "string" &&
                typeof detail === "string" &&
                detail.length <= 160 &&
                validStatus &&
                detail ===
                  HISTORY_SEMANTIC_CAPABILITY_DETAILS[
                    status as keyof typeof HISTORY_SEMANTIC_CAPABILITY_DETAILS
                  ];
              semanticSummaryCapabilityAvailable =
                Object.keys(message).every((key) => capabilityKeys.has(key)) &&
                Object.keys(message).length === capabilityKeys.size &&
                validStatus &&
                validDetail &&
                status === "available";
            } else if (message.type === "history_browser_capabilities") {
              if (Array.isArray(message.browsers)) {
                const nextCapabilities = message.browsers.flatMap((value) => {
                  if (!value || typeof value !== "object") return [];
                  const candidate = value as Record<string, unknown>;
                  const status = candidate.status;
                  if (
                    typeof candidate.bundleIdentifier !== "string" ||
                    typeof candidate.name !== "string" ||
                    (status !== "supported" &&
                      status !== "permission_denied" &&
                      status !== "unsupported" &&
                      status !== "unknown") ||
                    typeof candidate.detail !== "string"
                  ) {
                    return [];
                  }
                  return [
                    {
                      bundleIdentifier: candidate.bundleIdentifier,
                      name: candidate.name,
                      status: status as ComputerHistoryBrowserCapabilityType["status"],
                      detail: candidate.detail,
                    },
                  ];
                });
                if (nextCapabilities.length > 0) {
                  const merged = new Map(
                    browserCapabilities.map((capability) => [
                      capability.bundleIdentifier,
                      capability,
                    ]),
                  );
                  for (const capability of nextCapabilities) {
                    merged.set(capability.bundleIdentifier, capability);
                  }
                  browserCapabilities = [...merged.values()];
                  // The helper has explicitly described every browser route it
                  // may observe; unknown/unsupported routes remain fail-closed.
                  privacyDecisionEnforced = true;
                }
              }
            } else if (message.type === "history_applications") {
              if (Array.isArray(message.applications)) {
                for (const value of message.applications) {
                  if (!value || typeof value !== "object") continue;
                  const candidate = value as Record<string, unknown>;
                  if (
                    typeof candidate.bundleIdentifier === "string" &&
                    typeof candidate.name === "string" &&
                    candidate.bundleIdentifier.length > 0 &&
                    candidate.name.length > 0
                  ) {
                    const iconDataURL = normalizeHistoryAppIcon(candidate.iconDataURL);
                    cacheApplication({
                      bundleIdentifier: candidate.bundleIdentifier,
                      name: candidate.name,
                      ...(iconDataURL ? { iconDataURL } : {}),
                    });
                  }
                }
              }
            } else if (message.type === "history_permissions") {
              const permission = (value: unknown): ComputerHistoryPermissionState =>
                value === "granted" || value === "denied" || value === "restricted"
                  ? value
                  : "unknown";
              permissionState = {
                inputMonitoring: permission(message.inputMonitoring),
                accessibility: permission(message.accessibility),
                screenRecording: permission(message.screenRecording),
              };
              if (enabled) {
                void activate();
              }
            } else if (message.type === "history_capture_candidate") {
              const candidate = parseCaptureCandidate(message);
              if (!candidate || captureReceipts.has(candidate.requestId)) continue;
              for (const [requestId, receipt] of captureReceipts) {
                if (receipt.expiresAtMs <= now() || receipt.consumed)
                  captureReceipts.delete(requestId);
              }
              const browserCapability = browserCapabilities.find(
                (capability) => capability.bundleIdentifier === candidate.app.bundleIdentifier,
              );
              const knownBrowser = isWebBrowserBundle(candidate.app.bundleIdentifier);
              const browserFieldsPresent =
                candidate.window.url !== undefined || candidate.browserMode !== undefined;
              const explicitSupportedBrowser =
                browserCapability?.status === "supported" &&
                candidate.browserMode === "normal" &&
                typeof candidate.window.url === "string";
              const host = normalizeHost(candidate.window.url);
              const allowed =
                enabled &&
                recorderState === "running" &&
                activationState === "idle" &&
                !candidate.privateBrowsing &&
                isAllowed(
                  candidate.app.bundleIdentifier,
                  settings.observation.defaultApplicationBehavior,
                  settings.observation.allowlist,
                  settings.observation.blocklist,
                ) &&
                (!host ||
                  isAllowed(
                    host,
                    settings.observation.defaultURLBehavior,
                    settings.observation.urlAllowlist,
                    settings.observation.urlBlocklist,
                  )) &&
                (!browserFieldsPresent
                  ? !knownBrowser && !browserCapability
                  : Boolean(explicitSupportedBrowser) &&
                    Boolean(host) &&
                    (!knownBrowser || privacyDecisionEnforced));
              if (!allowed) {
                sendCaptureDecision(child, candidate, false);
                continue;
              }
              if (captureReceipts.size >= HISTORY_CAPTURE_RECEIPT_LIMIT) {
                sendCaptureDecision(child, candidate, false);
                continue;
              }
              captureReceipts.set(candidate.requestId, {
                ...candidate,
                expiresAtMs: now() + HISTORY_CAPTURE_RECEIPT_TIMEOUT_MS,
                consumed: false,
              });
              sendCaptureDecision(child, candidate, true);
            } else if (message.type === "history_observation") {
              const observationKeys = new Set([
                "type",
                "requestId",
                "fingerprint",
                "capturedAt",
                "app",
                "window",
                "activityText",
                "semanticSummary",
              ]);
              if (Object.keys(message).some((key) => !observationKeys.has(key))) continue;
              const requestId = protocolString(message.requestId, HISTORY_CAPTURE_ID_MAX_LENGTH);
              const fingerprint = protocolString(
                message.fingerprint,
                HISTORY_CAPTURE_FINGERPRINT_MAX_LENGTH,
              );
              const app = message.app;
              const capturedAt = protocolString(message.capturedAt, 128);
              const window = message.window;
              const activityText = message.activityText;
              const semanticSummaryValue = message.semanticSummary;
              const windowTitleValue =
                window && typeof window === "object" && !Array.isArray(window)
                  ? (window as Record<string, unknown>).title
                  : undefined;
              let semanticSummary: ComputerHistorySemanticSummary | undefined;
              if (semanticSummaryValue !== undefined) {
                try {
                  semanticSummary = normalizeComputerHistorySemanticSummary(semanticSummaryValue);
                } catch {
                  continue;
                }
              }
              if (semanticSummary !== undefined && activityText !== undefined) continue;
              if (
                (window !== undefined &&
                  (!window ||
                    typeof window !== "object" ||
                    Array.isArray(window) ||
                    Object.keys(window).some((key) => key !== "title") ||
                    (windowTitleValue !== undefined &&
                      (typeof windowTitleValue !== "string" ||
                        windowTitleValue.length > COMPUTER_HISTORY_MAX_WINDOW_TITLE_LENGTH)))) ||
                (activityText !== undefined &&
                  (typeof activityText !== "string" ||
                    activityText.length > COMPUTER_HISTORY_MAX_ACTIVITY_TEXT_LENGTH))
              ) {
                continue;
              }
              const receipt = requestId ? captureReceipts.get(requestId) : undefined;
              if (
                app &&
                typeof app === "object" &&
                !Array.isArray(app) &&
                Object.keys(app as Record<string, unknown>).some(
                  (key) => key !== "bundleIdentifier" && key !== "name",
                )
              ) {
                continue;
              }
              if (
                !requestId ||
                !fingerprint ||
                !/^[a-f0-9]{64}$/u.test(fingerprint) ||
                !receipt ||
                receipt.consumed ||
                receipt.expiresAtMs < now() ||
                fingerprint !== receipt.fingerprint ||
                !app ||
                typeof app !== "object" ||
                Array.isArray(app) ||
                typeof (app as Record<string, unknown>).bundleIdentifier !== "string" ||
                typeof (app as Record<string, unknown>).name !== "string" ||
                (app as Record<string, unknown>).bundleIdentifier !==
                  receipt.app.bundleIdentifier ||
                (app as Record<string, unknown>).name !== receipt.app.name ||
                !capturedAt
              ) {
                continue;
              }
              const capturedAtMs = Date.parse(capturedAt);
              if (
                !Number.isSafeInteger(capturedAtMs) ||
                capturedAtMs < 0 ||
                capturedAtMs < receipt.receivedAtMs - 1_000 ||
                capturedAtMs > receipt.expiresAtMs + 1_000
              ) {
                continue;
              }
              const isBrowser = isWebBrowserBundle(receipt.app.bundleIdentifier);
              if (
                semanticSummary !== undefined &&
                (!receipt || !semanticSummaryCapabilityAvailable)
              ) {
                continue;
              }
              const finalObservation: ComputerHistoryObservation = {
                capturedAtMs,
                app: {
                  bundleIdentifier: receipt.app.bundleIdentifier,
                  name: receipt.app.name,
                },
                window: {},
                ...(!isBrowser && typeof activityText === "string" ? { activityText } : {}),
                ...(semanticSummary === undefined ? {} : { semanticSummary }),
              };
              receipt.consumed = true;
              captureReceipts.delete(requestId);
              void recordHelperObservation(finalObservation, receipt);
            }
          } catch {
            semanticSummaryCapabilityAvailable = false;
            // The helper protocol is fail-closed: malformed helper output is
            // ignored and never treated as a successful capture.
          }
        }
      });
      child.once("exit", () => {
        if (historyHelper !== child || historyHelperGeneration !== generation) return;
        captureReceipts.clear();
        semanticSummaryCapabilityAvailable = false;
        historyHelper = null;
        historyHelperGeneration += 1;
        if (enabled && recorderState === "running") {
          activationState = "failed";
          recorderState = "stopped";
          lastError = "Computer History helper stopped unexpectedly.";
          void persistRuntimeState();
        }
      });
    } catch {
      semanticSummaryCapabilityAvailable = false;
      historyHelperGeneration += 1;
      activationState = "failed";
      recorderState = "stopped";
      lastError = "Computer History helper could not be started.";
    }
  };

  const setEnabled = async (
    input: ComputerHistorySetEnabledInput,
  ): Promise<ComputerHistoryState> => {
    await loadSettings();
    if (!input.enabled) {
      enabled = false;
      recorderState = "stopped";
      activationState = "idle";
      stopHistoryHelper();
      await persistRuntimeState();
      return runStoreOperation(() => stateWithStorage());
    }
    const consentAt = input.consentAt?.trim() || settings.consentAt;
    if (!consentAt) throw new Error("Computer History requires explicit privacy consent.");
    settings = { ...settings, consentAt };
    await persistSettings();
    enabled = true;
    recorderState = "stopped";
    await persistRuntimeState();
    await activate();
    return runStoreOperation(() => stateWithStorage());
  };

  const listHistoryUnsafe = async (
    input: ComputerHistoryListHistoryInput = {},
  ): Promise<ComputerHistoryListHistoryResult> => {
    const baseProjection = projectHistory({
      ...(input.sinceMs === undefined ? {} : { sinceMs: input.sinceMs }),
      ...(input.untilMs === undefined ? {} : { untilMs: input.untilMs }),
      limit: Math.min(COMPUTER_HISTORY_MAX_QUERY_RESULTS, Math.max(1, input.limit ?? 200)),
    });
    const resourcePaths = await syncHistoryResources();
    const projection = overlayRecursiveProjection(baseProjection, validatedRecursiveResources);
    // The resource index and the timeline share the same deterministic entry
    // id. Attach the resolved path only on the local/UI result; the Agent
    // Gateway applies an explicit safe projection and strips it before model
    // context is built.
    const entries: ComputerHistoryTimelineEntry[] = projection.entries.map((entry) => {
      const memoryFilePath = resourcePaths.get(entry.id);
      if (!memoryFilePath) {
        throw new Error(`Missing Computer History summary resource for ${entry.id}.`);
      }
      return { ...entry, memoryFilePath };
    });
    return {
      entries,
      nextCursor: null,
      modelContextDisclosure: {
        included: false,
        notImplicitlyInjected: true,
        text: "Computer History summaries are local-only and are not implicitly injected; the Agent Gateway marks entries included when this result is returned by history_query.",
      },
    };
  };

  const listHistory = async (
    input: ComputerHistoryListHistoryInput = {},
  ): Promise<ComputerHistoryListHistoryResult> => {
    // A user can open the timeline before ever opening the permissions picker.
    // Discover outside the encrypted-store serialization lane so a slow or
    // legacy helper cannot delay capture decisions or recorder activation.
    await ensureApplicationCatalog();
    return runStoreOperation(() => listHistoryUnsafe(input));
  };

  const persistSafeObservation = async (
    rawObservation: unknown,
    receipt?: HistoryCaptureReceipt,
  ): Promise<boolean> => {
    await loadSettings();
    let observation: ComputerHistoryObservation;
    try {
      if (!rawObservation || typeof rawObservation !== "object") return false;
      const candidate = rawObservation as Record<string, unknown>;
      const candidateApp = candidate.app;
      const candidateWindow = candidate.window;
      if (
        !candidateApp ||
        typeof candidateApp !== "object" ||
        Array.isArray(candidateApp) ||
        !candidateWindow ||
        typeof candidateWindow !== "object" ||
        Array.isArray(candidateWindow)
      ) {
        return false;
      }
      const windowRecord = candidateWindow as Record<string, unknown>;
      const privateBrowsing = candidate.privateBrowsing;
      if (privateBrowsing === true) return false;
      if (candidate.semanticSummary !== undefined && !receipt) return false;
      const url = windowRecord.url;
      // A URL is a transient policy field. Direct callers cannot persist it;
      // only the helper receipt path may carry a browser candidate through.
      if (url !== undefined && typeof url !== "string") return false;
      if (url !== undefined && !receipt) return false;
      const safeActivityText = sanitizeHistoryActivityText(candidate.activityText);
      observation = normalizeComputerHistoryObservation({
        capturedAtMs: candidate.capturedAtMs,
        app: candidateApp,
        // Public/direct calls cannot establish a privacy receipt. Keep their
        // title out of persistence just like the final helper path.
        window: {},
        ...(safeActivityText ? { activityText: safeActivityText } : {}),
        ...(candidate.semanticSummary === undefined
          ? {}
          : { semanticSummary: candidate.semanticSummary }),
      });
    } catch {
      return false;
    }
    const isKnownBrowser = isWebBrowserBundle(observation.app.bundleIdentifier);
    // Browser entries may only arrive through a live candidate receipt. Their
    // transient URL/private mode were already consumed by the policy gate and
    // cannot be reconstructed from the safe observation.
    if (isKnownBrowser && !receipt) return false;
    if (observation.semanticSummary !== undefined && !semanticSummaryCapabilityAvailable) {
      return false;
    }
    if (!enabled || recorderState !== "running" || activationState !== "idle") return false;
    const browserCapability = browserCapabilities.find(
      (capability) => capability.bundleIdentifier === observation.app.bundleIdentifier,
    );
    if (browserCapability && browserCapability.status !== "supported") return false;
    const appAllowed = isAllowed(
      observation.app.bundleIdentifier,
      settings.observation.defaultApplicationBehavior,
      settings.observation.allowlist,
      settings.observation.blocklist,
    );
    if (!appAllowed) return false;
    const receiptHost = normalizeHost(receipt?.window.url);
    if (
      receiptHost &&
      !isAllowed(
        receiptHost,
        settings.observation.defaultURLBehavior,
        settings.observation.urlAllowlist,
        settings.observation.urlBlocklist,
      )
    ) {
      return false;
    }
    if (queueDepth >= MAX_PENDING_WRITES) {
      droppedEvents += 1;
      return false;
    }
    queueDepth += 1;
    cacheApplication(observation.app);
    const write = runStoreOperation(async () => {
      if (!enabled || recorderState !== "running" || activationState !== "idle") return false;
      await store.append(observation);
      try {
        summaryJobEngine.addObservation(observation);
      } catch {
        // Summary jobs are a derived local index. A failed update keeps its
        // last-known-good snapshot and does not invalidate encrypted capture.
        lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
        summaryJobRefreshFailed = true;
      }
      const recordsBeforePrune = store.loadedRecords.length;
      await store.prune(now());
      if (store.loadedRecords.length !== recordsBeforePrune) {
        const retentionSince = Math.max(0, now() - COMPUTER_HISTORY_RETENTION_MS);
        const retainedInputs = store.loadedRecords.flatMap(({ observation }) => {
          if (
            !Number.isSafeInteger(observation.capturedAtMs) ||
            observation.capturedAtMs < retentionSince
          ) {
            return [];
          }
          try {
            return [toComputerHistorySafeSummaryInput(observation)];
          } catch {
            return [];
          }
        });
        summaryJobEngine.replaceInputs(retainedInputs);
        if (summaryJobEngine.hasPendingInputReplacement()) {
          summaryJobEngine.invalidatePublishedResources();
          // Retention is an explicit deletion boundary rather than ordinary
          // observation cadence. Rebuild once here so expired 10-minute and
          // 6-hour resources are removed immediately; normal observations
          // remain queued for the minute/hour schedulers above.
          if (summaryJobEngine.state() === "running") {
            try {
              const result = await summaryJobEngine.runPending(now(), "all");
              summaryJobRefreshFailed = result.failedJobKeys.length > 0;
              if (summaryJobRefreshFailed) lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
            } catch {
              summaryJobRefreshFailed = true;
              lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
            }
          }
        }
      }
      try {
        await syncHistoryResources();
      } catch {
        lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
      }
      return true;
    });
    try {
      const written = await write;
      if (!written) return false;
      return true;
    } catch {
      lastError = "Computer History could not persist an authenticated record.";
      activationState = "failed";
      recorderState = "stopped";
      stopHistoryHelper();
      await persistRuntimeState();
      return false;
    } finally {
      queueDepth = Math.max(0, queueDepth - 1);
    }
  };

  const recordHelperObservation = async (
    observation: ComputerHistoryObservation,
    receipt: HistoryCaptureReceipt,
  ): Promise<boolean> => persistSafeObservation(observation, receipt);

  const service: ComputerHistoryService = {
    getState: async (_input?: ComputerHistoryGetStateInput) => {
      await loadSettings();
      try {
        await ensureLoaded();
      } catch {
        return stateWithStorage();
      }
      await restoreRuntimeIfNeeded();
      return runStoreOperation(() => stateWithStorage());
    },
    getSettings: async (_input?: ComputerHistoryGetSettingsInput) => {
      await loadSettings();
      return cloneSettings(settings);
    },
    updateSettings: async (input: ComputerHistoryUpdateSettingsInput) => {
      await loadSettings();
      settings = parseSettings(input.settings);
      await persistSettings();
      if (enabled && recorderState !== "paused") await activate();
      return runStoreOperation(() => stateWithStorage());
    },
    listApplications: async () => {
      await ensureApplicationCatalog();
      return runStoreOperation(async () => {
        return {
          applications: [...applicationCatalog.values()]
            .sort((left, right) => {
              const leftOrder = applicationDiscoveryOrder.get(left.bundleIdentifier);
              const rightOrder = applicationDiscoveryOrder.get(right.bundleIdentifier);
              if (leftOrder !== undefined || rightOrder !== undefined) {
                if (leftOrder === undefined) return 1;
                if (rightOrder === undefined) return -1;
                if (leftOrder !== rightOrder) return leftOrder - rightOrder;
              }
              return left.bundleIdentifier.localeCompare(right.bundleIdentifier);
            })
            .map((application) => ({
              bundleIdentifier: application.bundleIdentifier,
              name: application.name,
              isWebBrowser: isWebBrowserBundle(application.bundleIdentifier),
              ...(application.iconDataURL ? { iconDataURL: application.iconDataURL } : {}),
              permitted: isAllowed(
                application.bundleIdentifier,
                settings.observation.defaultApplicationBehavior,
                settings.observation.allowlist,
                settings.observation.blocklist,
              ),
            })),
        };
      });
    },
    resolveApplications: async (input: ComputerHistoryResolveApplicationsInput) => {
      const result = await service.listApplications();
      if (input.bundleIdentifiers !== undefined) {
        const applicationsByBundleIdentifier = new Map(
          result.applications.map((application) => [application.bundleIdentifier, application]),
        );
        const seen = new Set<string>();
        return {
          applications: input.bundleIdentifiers.flatMap((bundleIdentifier) => {
            const normalizedBundleIdentifier = bundleIdentifier.trim();
            if (seen.has(normalizedBundleIdentifier)) return [];
            seen.add(normalizedBundleIdentifier);
            const application = applicationsByBundleIdentifier.get(normalizedBundleIdentifier);
            return application ? [application] : [];
          }),
        };
      }
      const query = input.query?.trim().toLowerCase() ?? "";
      return {
        applications: query
          ? result.applications.filter(
              (app) =>
                app.name.toLowerCase().includes(query) ||
                app.bundleIdentifier.toLowerCase().includes(query),
            )
          : result.applications,
      };
    },
    setEnabled,
    retryActivation: async () => {
      await loadSettings();
      if (!enabled) return runStoreOperation(() => stateWithStorage());
      // A waiting helper has already reported its old TCC state. Restart it
      // for an explicit retry so it re-runs the Screen Recording preflight;
      // ordinary getState calls never trigger a permission prompt.
      stopHistoryHelper();
      await activate();
      return runStoreOperation(() => stateWithStorage());
    },
    pause: async () => {
      await loadSettings();
      if (enabled && recorderState === "running") {
        recorderState = "paused";
        stopHistoryHelper();
        await persistRuntimeState();
      }
      return runStoreOperation(() => stateWithStorage());
    },
    resume: async () => {
      await loadSettings();
      if (enabled && recorderState === "paused") {
        recorderState = "running";
        await activate();
      }
      return runStoreOperation(() => stateWithStorage());
    },
    listHistory,
    listHistorySuggestions: async (input: ComputerHistoryListSuggestionsInput = {}) =>
      runStoreOperation(async () => {
        const currentNow = now();
        // Project the complete, validated resource timeline first. Rebuilding
        // six-hour buckets from a narrow sinceMs would drop the owning parent
        // when all of its observations fall before the requested boundary.
        const baseProjection = projectHistory();
        const resourcePaths = await syncHistoryResources();
        const projection = overlayRecursiveProjection(baseProjection, validatedRecursiveResources);
        const historyEntries = projection.entries.flatMap((entry) => {
          const memoryFilePath = resourcePaths.get(entry.id);
          if (!memoryFilePath && entry.suggestion) {
            throw new Error(`Missing Computer History summary resource for ${entry.id}.`);
          }
          if (!memoryFilePath) return [];
          return [{ ...entry, memoryFilePath }];
        });
        // Keep the source projection's inclusive boundary: a summary owning
        // an observation exactly at now-48h is still eligible. A caller's
        // sinceMs only narrows that boundary.
        const sinceMs = Math.max(
          currentNow - COMPUTER_HISTORY_SUGGESTION_WINDOW_MS,
          input.sinceMs ?? 0,
        );
        const resourcesByEntryId = new Map(
          projection.resources.map((resource) => [resource.entryId, resource]),
        );
        // A visible completed six-hour parent supersedes its ten-minute
        // children, so each qualifying suggestion has exactly one stable
        // owning entry ID. The set is still defensive against malformed
        // projections and keeps the response deterministic.
        const seenEntryIds = new Set<string>();
        const suggestions = historyEntries
          .filter((entry) => {
            if (!entry.suggestion) return false;
            const resource = resourcesByEntryId.get(entry.id);
            return Boolean(
              resource?.observationTimestamps.some(
                (capturedAtMs) => capturedAtMs >= sinceMs && capturedAtMs <= currentNow,
              ),
            );
          })
          .sort(
            (left, right) =>
              right.interval.startMs - left.interval.startMs || right.id.localeCompare(left.id),
          )
          .flatMap((entry) => {
            if (seenEntryIds.has(entry.id) || !entry.suggestion) return [];
            seenEntryIds.add(entry.id);
            const suggestion = entry.suggestion;
            const prompt =
              suggestion.type === "skill"
                ? `Create a new "${suggestion.name}" skill based on the description below. Consult the memory at ${entry.memoryFilePath} and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"${suggestion.description}"`
                : `Create a new "${suggestion.name}" automation based on the description below. Consult the memory at ${entry.memoryFilePath} and the events.jsonl files cited there to understand the recorded workflow and my actions.\n\n"${suggestion.description}"\n\nUse my local timezone and a new chat for scheduled runs.`;
            return [
              {
                id: entry.id,
                title: suggestion.name,
                explanation: suggestion.description,
                prompt,
                kind: suggestion.type,
              },
            ];
          });
        return { suggestions };
      }),
    listHistorySummaryIntervals: async (input: ComputerHistoryListSummaryIntervalsInput) => {
      return runStoreOperation(async () => {
        const baseProjection = projectHistory({ sinceMs: input.sinceMs });
        await syncHistoryResources();
        const projection = overlayRecursiveProjection(baseProjection, validatedRecursiveResources);
        return { intervals: [...projection.intervals] };
      });
    },
    revealInFinder: async (input: ComputerHistoryRevealInFinderInput) => {
      if (process.platform !== "darwin") return { opened: false };
      return runStoreOperation(async () => {
        const baseProjection = projectHistory();
        const resourcePaths = await syncHistoryResources();
        const projection = overlayRecursiveProjection(baseProjection, validatedRecursiveResources);
        const resource = projection.resources.find(
          (candidate) => candidate.entryId === input.entryId,
        );
        if (!resource) return { opened: false };
        const path = resourcePaths.get(resource.entryId);
        const recursivePath = validatedRecursiveResources.get(resource.entryId)?.path;
        const jobPath = recursivePath
          ? resolveComputerHistorySummaryJobResourcePath(
              options.rootDir,
              recursivePath.split("/").pop() ?? "",
            )
          : null;
        const exactPath =
          jobPath === path
            ? jobPath
            : path
              ? resolveComputerHistorySummaryPath(options.rootDir, resource.filename)
              : null;
        if (!exactPath || exactPath !== path) return { opened: false };
        try {
          if (options.revealInFinder) {
            await options.revealInFinder(exactPath);
          } else {
            await execFile("/usr/bin/open", ["-R", exactPath], { maxBuffer: 16 * 1024 });
          }
          return { opened: true };
        } catch {
          return { opened: false };
        }
      });
    },
    clearHistory: async (input: ComputerHistoryClearHistoryInput) =>
      runStoreOperation(async () => {
        const end = now();
        const start =
          input.scope === "all"
            ? 0
            : (input.intervalStartMs ??
              (input.scope === "last_10m"
                ? end - 10 * 60 * 1_000
                : input.scope === "last_1h"
                  ? end - 60 * 60 * 1_000
                  : end - 24 * 60 * 60 * 1_000));
        const explicitEnd = input.intervalEndMs ?? end;
        const kept = store.loadedRecords.filter(
          ({ observation }) =>
            observation.capturedAtMs < start || observation.capturedAtMs > explicitEnd,
        );
        const deletedCount = store.loadedRecords.length - kept.length;
        if (deletedCount > 0) await store.replace(kept);
        if (deletedCount > 0 || input.scope === "all") {
          // A deletion can leave the same bucket/key alive with fewer
          // observations. Revoke the recursive overlay before any list,
          // reveal, or model projection can observe the old content.
          summaryJobEngine.invalidatePublishedResources();
          validatedRecursiveResources = new Map();
        }
        if (input.scope === "all") await auditStore.clear();
        const summaryJobsRunning = summaryJobEngine.state() === "running";
        try {
          const safeInputs = kept.flatMap(({ observation }) => {
            try {
              return [toComputerHistorySafeSummaryInput(observation)];
            } catch {
              return [];
            }
          });
          summaryJobEngine.replaceInputs(safeInputs);
          if (summaryJobsRunning) {
            const result = await summaryJobEngine.runPending(now(), "all");
            summaryJobRefreshFailed = result.failedJobKeys.length > 0;
            if (summaryJobRefreshFailed) lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
          }
        } catch {
          lastError = SUMMARY_RESOURCE_REFRESH_ERROR;
          summaryJobRefreshFailed = true;
        }
        await syncHistoryResources();
        if (input.scope === "all") {
          summaryJobEngine.invalidatePublishedResources();
          await removeComputerHistorySummaryJobResources(options.rootDir);
        }
        return { deletedCount, summaryIndexRefresh: "complete" };
      }),
    recordObservation: async (observation: ComputerHistoryRecordInput) =>
      persistSafeObservation(observation),
    recordAccessAudit,
  };
  return service;
}
