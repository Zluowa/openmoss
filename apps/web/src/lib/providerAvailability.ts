import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
  type SupportedProviderKind,
} from "@synara/contracts";
import { isProviderKind } from "../providerOrdering";

const CUSTOM_BINARY_CONFIRMATION_SUFFIX =
  "Availability will be confirmed when you start a session.";

export type ProviderSendBlockedReasonKind =
  | "disabled"
  | "unauthenticated"
  | "unavailable"
  | "status-loading"
  | "status-timeout";

export type ProviderAvailabilityPresentationKind = ProviderSendBlockedReasonKind | "transient";

export const PROVIDER_DISABLED_STATUS_MESSAGE = "Provider is disabled in Moss settings.";
export const PROVIDER_STATUS_REFRESH_TIMEOUT_MS = 4_000;

export interface ProviderSendAdmission {
  readonly state: "ready" | "preflight" | "blocked";
  readonly unavailableReason: string | null;
}
export const PROVIDER_STATUS_LOADING_REASON = "Provider status is still loading.";
export const PROVIDER_STATUS_REFRESH_TIMEOUT_REASON =
  "Provider status check timed out. Choose another available provider or try again.";

export interface ProviderSendAvailability {
  readonly provider: ProviderKind;
  readonly status: ServerProviderStatus | null;
  readonly usable: boolean;
  readonly unavailableReason: string;
}

export type ProviderStatusRefresh = () => Promise<
  readonly ServerProviderStatus[] | null | undefined
>;

export function normalizeCustomBinaryPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProviderStatusForLocalConfig(input: {
  provider: ProviderKind;
  status: ServerProviderStatus | null | undefined;
  customBinaryPath?: string | null | undefined;
  confirmedCustomBinaryPath?: string | null | undefined;
  disabled?: boolean | undefined;
}): ServerProviderStatus | null {
  const status = input.status ?? null;
  if (!status) {
    return null;
  }
  if (input.disabled) {
    return {
      ...status,
      provider: input.provider,
      enabled: false,
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: status.checkedAt,
      message: "Provider is disabled in Moss settings.",
    };
  }

  if (status.enabled === false) {
    return status;
  }

  const customBinaryPath = normalizeCustomBinaryPath(input.customBinaryPath);
  if (!customBinaryPath) {
    return status;
  }

  if (normalizeCustomBinaryPath(status.autoRuntimeModeBinaryPath) === customBinaryPath) {
    return status;
  }

  const {
    supportsAutoRuntimeMode: _staleAutoSupport,
    autoRuntimeModeBinaryPath: _staleAutoBinaryPath,
    availability: _staleAvailability,
    unavailableReason: _staleUnavailableReason,
    ...statusWithoutStaleAutoCapability
  } = status;

  if (status.available || status.authStatus !== "unknown") {
    return statusWithoutStaleAutoCapability;
  }

  if (normalizeCustomBinaryPath(input.confirmedCustomBinaryPath) === customBinaryPath) {
    // Only the exact path used by a successful session can suppress the warning.
    const { message: _message, ...confirmedStatus } = statusWithoutStaleAutoCapability;
    return {
      ...confirmedStatus,
      available: true,
      ...(_staleAvailability !== undefined ? { availability: "available" as const } : {}),
      status: "ready",
    };
  }

  return {
    ...statusWithoutStaleAutoCapability,
    available: true,
    ...(_staleAvailability !== undefined ? { availability: "available" as const } : {}),
    status: "warning",
    message: `${PROVIDER_DISPLAY_NAMES[input.provider]} uses a custom local binary path in this app. ${CUSTOM_BINARY_CONFIRMATION_SUFFIX}`,
  };
}

export function providerStatusInstanceKey(
  status: Pick<ServerProviderStatus, "provider" | "instanceId">,
): ProviderInstanceId {
  return status.instanceId ?? status.provider;
}

// Advisory warnings the health layer marks available (Pi bundled SDK, Cursor
// model-discovery warnings, unconfirmed custom binaries) stay sendable; only
// unavailable or unauthenticated statuses block sends.
export function isProviderUsable(status: ServerProviderStatus | null | undefined): boolean {
  if (!status) {
    // Missing status means the health check has not confirmed an installed provider yet.
    return false;
  }
  return (
    status.enabled !== false &&
    status.status !== "error" &&
    status.available &&
    status.authStatus !== "unauthenticated"
  );
}

export function providerUnavailableReason(status: ServerProviderStatus | null | undefined): string {
  const providerLabel = providerStatusDisplayLabel(status);
  const presentationKind = resolveProviderAvailabilityPresentationKind({ status });
  switch (presentationKind) {
    case "status-loading":
      return PROVIDER_STATUS_LOADING_REASON;
    case "status-timeout":
      return PROVIDER_STATUS_REFRESH_TIMEOUT_REASON;
    case "disabled":
      return PROVIDER_DISABLED_STATUS_MESSAGE;
    case "unauthenticated":
      return `${providerLabel} is not authenticated yet.`;
    case "unavailable":
      // Managed runtimes redact local diagnostics (paths, EPERM, transport detail);
      // the user cannot act on them and they leak the machine layout.
      return isMossManagedProviderStatus(status)
        ? "Moss is temporarily unavailable."
        : `${providerLabel} is unavailable right now.`;
    case "transient":
      return isMossManagedProviderStatus(status)
        ? "Moss is getting ready."
        : `${providerLabel} has limited availability right now.`;
  }
}

/**
 * Moss-managed relay instances keyed by their reserved instance id. The driver
 * is the only mapping the web needs: every managed instance is a server-owned
 * `<driver>_moss` record whose config carries `managed: true`.
 */
const MOSS_DEFAULT_MANAGED_PROVIDER_DRIVER_BY_INSTANCE_ID: ReadonlyMap<
  ProviderInstanceId,
  SupportedProviderKind
> = new Map<ProviderInstanceId, SupportedProviderKind>([
  ["codex_moss", "codex"],
  ["claude_moss", "claudeAgent"],
  ["opencode_moss", "opencode"],
  ["pi_moss", "pi"],
  ["grok_moss", "grok"],
  ["hermes_moss", "hermes"],
  ["kimi_moss", "kimi"],
  ["minimax_moss", "minimax"],
  ["zcode_moss", "zcode"],
]);

export function mossDefaultManagedProviderDriver(
  instanceId: ProviderInstanceId | string | null | undefined,
): SupportedProviderKind | undefined {
  return typeof instanceId === "string"
    ? MOSS_DEFAULT_MANAGED_PROVIDER_DRIVER_BY_INSTANCE_ID.get(instanceId as ProviderInstanceId)
    : undefined;
}

export function providerStatusProviderKind(
  status: Pick<ServerProviderStatus, "provider" | "driver"> | null | undefined,
): ProviderKind | null {
  if (!status) {
    return null;
  }
  const driver = status.driver;
  return typeof driver === "string" && isProviderKind(driver) ? driver : null;
}

export function isMossDefaultManagedProviderInstanceId(
  instanceId: ProviderInstanceId | string | null | undefined,
): boolean {
  return mossDefaultManagedProviderDriver(instanceId) !== undefined;
}

export function isServerConfiguredMossDefaultManagedProvider(
  settings:
    | (Pick<ServerSettings, "providerInstances"> & Partial<Pick<ServerSettings, "providers">>)
    | null
    | undefined,
  instanceId: ProviderInstanceId | string | null | undefined,
): boolean {
  const expectedDriver = mossDefaultManagedProviderDriver(instanceId);
  if (!settings || expectedDriver === undefined) {
    return false;
  }
  const providerInstance = settings.providerInstances[instanceId as ProviderInstanceId];
  const config = providerInstance?.config;
  return (
    providerInstance !== undefined &&
    providerInstance.enabled !== false &&
    settings.providers?.[expectedDriver]?.enabled !== false &&
    providerInstance.driver === expectedDriver &&
    typeof config === "object" &&
    config !== null &&
    !Array.isArray(config) &&
    "managed" in config &&
    config.managed === true &&
    (!("enabled" in config) || config.enabled !== false)
  );
}

export function isMossManagedProviderStatus(
  status: Pick<ServerProviderStatus, "instanceId" | "displayName"> | null | undefined,
): boolean {
  return (
    isMossDefaultManagedProviderInstanceId(status?.instanceId) ||
    status?.instanceId === "opencode_moss"
  );
}

const MOSS_MANAGED_STARTUP_STATUS_MAX_AGE_MS = 5 * 60_000;
const MOSS_MANAGED_STARTUP_STATUS_FUTURE_SKEW_MS = 30_000;

export function isFreshMossManagedStartupStatus(
  status: ServerProviderStatus | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (
    !status ||
    !isMossDefaultManagedProviderInstanceId(status.instanceId) ||
    status.enabled === false ||
    status.status !== "warning" ||
    status.available !== false ||
    status.authStatus === "unauthenticated" ||
    status.availability === "unavailable"
  ) {
    return false;
  }
  const checkedAtMs = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return false;
  }
  const ageMs = nowMs - checkedAtMs;
  return (
    ageMs >= -MOSS_MANAGED_STARTUP_STATUS_FUTURE_SKEW_MS &&
    ageMs <= MOSS_MANAGED_STARTUP_STATUS_MAX_AGE_MS
  );
}

export function providerStatusDisplayLabel(
  status: ServerProviderStatus | null | undefined,
  fallbackProvider?: ProviderKind,
): string {
  const provider = status?.driver ?? status?.provider ?? fallbackProvider;
  const providerLabelFallback =
    provider && isProviderKind(provider) ? PROVIDER_DISPLAY_NAMES[provider] : provider;
  return status?.displayName?.trim() || providerLabelFallback || "Provider";
}

export function isProviderDisabledStatus(status: ServerProviderStatus | null | undefined): boolean {
  // `enabled: false` also represents provider kinds unsupported by this build.
  // Match the health layer's settings-disabled overlay authority exactly.
  return status?.available === false && status.message === PROVIDER_DISABLED_STATUS_MESSAGE;
}

/**
 * Separates terminal provider truth from a genuinely refreshable warning. The
 * health service uses warning + unavailable while an enabled instance has not
 * been checked yet, so that shape must remain transient. Disabled, auth, error,
 * and explicitly unavailable states are already actionable and fail closed.
 */
export function isProviderDurablyUnavailable(
  status: ServerProviderStatus | null | undefined,
): boolean {
  if (!status || isProviderUsable(status)) {
    return false;
  }
  return (
    status.enabled === false ||
    isProviderDisabledStatus(status) ||
    status.authStatus === "unauthenticated" ||
    status.status === "error" ||
    status.availability === "unavailable" ||
    status.status === "ready"
  );
}

/**
 * Classifies provider health for user-facing copy without consulting runtime
 * diagnostics. `message` and `unavailableReason` remain diagnostic data only;
 * the timeout sentinel is the sole safe product-owned reason string used here.
 */
export function resolveProviderAvailabilityPresentationKind(input: {
  readonly status: ServerProviderStatus | null | undefined;
  readonly unavailableReason?: string | null | undefined;
}): ProviderAvailabilityPresentationKind {
  if (input.unavailableReason === PROVIDER_STATUS_REFRESH_TIMEOUT_REASON) {
    return "status-timeout";
  }
  const status = input.status ?? null;
  if (!status) {
    return "status-loading";
  }
  if (isProviderDisabledStatus(status)) {
    return "disabled";
  }
  if (status.authStatus === "unauthenticated") {
    return "unauthenticated";
  }
  return isProviderDurablyUnavailable(status) ? "unavailable" : "transient";
}

export function resolveProviderSendBlockedReasonKind(input: {
  readonly status: ServerProviderStatus | null;
  readonly unavailableReason: string;
}): ProviderSendBlockedReasonKind {
  const presentationKind = resolveProviderAvailabilityPresentationKind(input);
  return presentationKind === "transient" ? "unavailable" : presentationKind;
}

export function findProviderStatus(
  statuses: readonly ServerProviderStatus[],
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | null | undefined,
): ServerProviderStatus | null {
  if (instanceId) {
    return (
      statuses.find(
        (status) =>
          (status.instanceId ?? status.provider) === instanceId &&
          ((status.driver ?? status.provider) === provider ||
            // Unknown drivers have no ProviderKind to match. Their exact
            // instance's terminal failure must still block this selection.
            !isProviderKind(status.driver ?? status.provider)),
      ) ?? null
    );
  }
  return statuses.find((status) => (status.driver ?? status.provider) === provider) ?? null;
}

export function resolveAvailableProviderPreference(input: {
  readonly preferredProvider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerOrder?: readonly ProviderKind[];
  readonly hiddenProviders?: readonly ProviderKind[];
}): ProviderKind {
  if (input.statuses.length === 0) {
    return input.preferredProvider;
  }

  const preferredStatus = findProviderStatus(input.statuses, input.preferredProvider);
  if (isProviderUsable(preferredStatus)) {
    return input.preferredProvider;
  }

  const hiddenProviders = new Set(input.hiddenProviders ?? []);
  const providerOrder = input.providerOrder ?? [];
  const providerForStatus = (status: ServerProviderStatus): ProviderKind | null => {
    const driver = status.driver ?? status.provider;
    return isProviderKind(driver) ? driver : null;
  };
  const orderedStatuses = input.statuses.toSorted((left, right) => {
    const leftProvider = providerForStatus(left);
    const rightProvider = providerForStatus(right);
    const leftIndex = leftProvider ? providerOrder.indexOf(leftProvider) : -1;
    const rightIndex = rightProvider ? providerOrder.indexOf(rightProvider) : -1;
    const normalizedLeft = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const normalizedRight = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    return normalizedLeft - normalizedRight;
  });
  const visibleInstalled = orderedStatuses.filter((status) => {
    const provider = providerForStatus(status);
    return status.available && provider !== null && !hiddenProviders.has(provider);
  });
  const installed =
    visibleInstalled.length > 0
      ? visibleInstalled
      : orderedStatuses.filter((status) => status.available && providerForStatus(status) !== null);

  const preferredInstalled =
    installed.find((status) => status.authStatus !== "unauthenticated") ?? installed[0];
  return (
    (preferredInstalled ? providerForStatus(preferredInstalled) : null) ?? input.preferredProvider
  );
}

/**
 * Provider an unsent composer sends with: the thread's explicit pick wins (availability
 * is validated at send time); otherwise the thread/project default, else the app default,
 * swapped for the first usable provider when that one is unavailable. Shared by the
 * composer and every surface that labels a draft by provider (e.g. its open-thread tab).
 */
export function resolveUnsentComposerProvider(input: {
  readonly explicitProvider: ProviderKind | null;
  readonly threadProvider: ProviderKind | null;
  readonly defaultProvider: ProviderKind;
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerOrder?: readonly ProviderKind[];
  readonly hiddenProviders?: readonly ProviderKind[];
}): ProviderKind {
  return (
    input.explicitProvider ??
    resolveAvailableProviderPreference({
      preferredProvider: input.threadProvider ?? input.defaultProvider,
      statuses: input.statuses,
      ...(input.providerOrder ? { providerOrder: input.providerOrder } : {}),
      ...(input.hiddenProviders ? { hiddenProviders: input.hiddenProviders } : {}),
    })
  );
}

export interface VoiceTranscriptionTarget {
  readonly instanceId: ProviderInstanceId;
  readonly status: ServerProviderStatus;
}

// Voice always uses a Codex ChatGPT session. Prefer the actively selected Codex
// account when it advertises voice, otherwise choose a usable configured account
// by identity (default first, then stable instance id). Status-only identities are
// deliberately ignored because they can outlive a removed or disabled account.
export function resolveVoiceTranscriptionTarget(input: {
  readonly statuses: readonly ServerProviderStatus[];
  readonly providerInstances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderKind;
    readonly enabled: boolean;
    readonly isDefault: boolean;
  }>;
  readonly selectedProvider: ProviderKind;
  readonly selectedProviderInstanceId: ProviderInstanceId;
}): VoiceTranscriptionTarget | null {
  const statusByInstanceId = new Map<ProviderInstanceId, ServerProviderStatus>();
  for (const status of input.statuses) {
    if ((status.driver ?? status.provider) !== "codex") {
      continue;
    }
    statusByInstanceId.set(providerStatusInstanceKey(status), status);
  }

  const orderedInstanceIds = input.providerInstances
    .filter((instance) => instance.provider === "codex" && instance.enabled)
    .toSorted((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return String(left.instanceId).localeCompare(String(right.instanceId));
    })
    .map((instance) => instance.instanceId);

  if (input.selectedProvider === "codex") {
    const selectedIndex = orderedInstanceIds.indexOf(input.selectedProviderInstanceId);
    if (selectedIndex >= 0) {
      orderedInstanceIds.splice(selectedIndex, 1);
      orderedInstanceIds.unshift(input.selectedProviderInstanceId);
    }
  }

  const isUsableVoiceStatus = (instanceId: ProviderInstanceId): boolean => {
    const status = statusByInstanceId.get(instanceId);
    return isProviderUsable(status);
  };
  const capableInstanceId = orderedInstanceIds.find((instanceId) => {
    const status = statusByInstanceId.get(instanceId);
    return isUsableVoiceStatus(instanceId) && status?.voiceTranscriptionAvailable === true;
  });
  const fallbackInstanceId =
    capableInstanceId ?? orderedInstanceIds.find((instanceId) => isUsableVoiceStatus(instanceId));
  if (!fallbackInstanceId) {
    return null;
  }
  const status = statusByInstanceId.get(fallbackInstanceId);
  return status ? { instanceId: fallbackInstanceId, status } : null;
}

// Composer-facing seam for distinguishing a refreshable, not-yet-known local
// provider from a provider that is already known to be unavailable. Moss-managed
// runtimes start on demand: their background inventory hydration is not a user
// action and must not become a send preflight or a chat-level startup check.
export function resolveProviderSendAdmission(
  status: ServerProviderStatus | null | undefined,
  instanceId?: ProviderInstanceId | null | undefined,
  managedInstanceConfigured = false,
  nowMs = Date.now(),
): ProviderSendAdmission {
  if (isProviderUsable(status)) {
    return { state: "ready", unavailableReason: null };
  }
  if (isProviderDurablyUnavailable(status)) {
    return {
      state: "blocked",
      unavailableReason: providerUnavailableReason(status),
    };
  }
  const resolvedInstanceId = instanceId ?? status?.instanceId;
  const isConfiguredManagedStartup =
    managedInstanceConfigured && isMossDefaultManagedProviderInstanceId(resolvedInstanceId);
  const isManagedStartupHydration =
    isMossDefaultManagedProviderInstanceId(resolvedInstanceId) &&
    (status === null || status === undefined
      ? isConfiguredManagedStartup
      : isConfiguredManagedStartup || isFreshMossManagedStartupStatus(status, nowMs));
  if (isManagedStartupHydration) {
    return { state: "ready", unavailableReason: null };
  }
  return { state: "preflight", unavailableReason: null };
}

// Shared send gate used by chat, Kanban, shortcuts, and handoff flows.
export function resolveProviderSendAvailability(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly statuses: readonly ServerProviderStatus[];
  readonly managedInstanceConfigured?: boolean | undefined;
}): ProviderSendAvailability {
  const status = findProviderStatus(input.statuses, input.provider, input.instanceId);
  const admission = resolveProviderSendAdmission(
    status,
    input.instanceId,
    input.managedInstanceConfigured,
  );
  return {
    provider: input.provider,
    status,
    usable: admission.state === "ready",
    unavailableReason: admission.unavailableReason ?? providerUnavailableReason(status),
  };
}

function shouldRefreshBeforeBlocking(status: ServerProviderStatus | null): boolean {
  // Stale unauthenticated statuses can clear on their own (a sign-in completing
  // in another window), so they always earn one recheck before blocking a send.
  return (
    !status ||
    status.authStatus === "unauthenticated" ||
    (!isProviderDurablyUnavailable(status) && !status.available)
  );
}

// Re-check a blocked provider once before surfacing stale install/auth state to the user.
// Refresh only genuinely unresolved health. Durable disabled/auth/error truth is
// already actionable and must not put the composer into a misleading wait state.
export async function resolveProviderSendAvailabilityWithRefresh(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | null | undefined;
  readonly statuses: readonly ServerProviderStatus[];
  readonly managedInstanceConfigured?: boolean | undefined;
  readonly refreshStatuses: ProviderStatusRefresh;
  readonly refreshTimeoutMs?: number;
}): Promise<ProviderSendAvailability> {
  const initial = resolveProviderSendAvailability(input);
  if (initial.usable || !shouldRefreshBeforeBlocking(initial.status)) {
    return initial;
  }

  const requestedTimeoutMs = input.refreshTimeoutMs ?? PROVIDER_STATUS_REFRESH_TIMEOUT_MS;
  const refreshTimeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= 0
      ? requestedTimeoutMs
      : PROVIDER_STATUS_REFRESH_TIMEOUT_MS;
  type RefreshOutcome =
    | {
        readonly kind: "resolved";
        readonly statuses: readonly ServerProviderStatus[] | null | undefined;
      }
    | { readonly kind: "failed" }
    | { readonly kind: "timed-out" };
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const refreshOutcomePromise: Promise<RefreshOutcome> = Promise.resolve()
    .then(input.refreshStatuses)
    .then((statuses) => ({ kind: "resolved" as const, statuses }))
    .catch(() => ({ kind: "failed" as const }));
  const timeoutPromise = new Promise<RefreshOutcome>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timed-out" }), refreshTimeoutMs);
  });
  const refreshOutcome = await Promise.race([refreshOutcomePromise, timeoutPromise]);
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
  }
  if (refreshOutcome.kind === "timed-out") {
    return {
      ...initial,
      unavailableReason: isProviderDurablyUnavailable(initial.status)
        ? initial.unavailableReason
        : PROVIDER_STATUS_REFRESH_TIMEOUT_REASON,
    };
  }
  if (refreshOutcome.kind === "failed" || !refreshOutcome.statuses) {
    return initial;
  }

  return resolveProviderSendAvailability({
    provider: input.provider,
    instanceId: input.instanceId,
    statuses: refreshOutcome.statuses,
    managedInstanceConfigured: input.managedInstanceConfigured,
  });
}
