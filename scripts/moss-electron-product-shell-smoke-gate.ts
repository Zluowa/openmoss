import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const EXPECTED_ROUTE = "moss://app/index.html#/thread-moss-served-smoke?mossShell=1";
const EXPECTED_ACTIVE_THREAD_ID = "thread-moss-served-smoke";
const EXPECTED_SELECTED_THREAD_ID = "thread-moss-served-smoke-secondary";
const EXPECTED_SELECTED_LAUNCH_PLAN_HASH = "sha256:moss-served-smoke-secondary";
const EXPECTED_CODEX_DESKTOP_BASELINE_SCREENSHOT =
  ".moss/ledger/evidence/codex-desktop-current-shell-2026-07-03.png";
const REQUIRED_CODEX_DESKTOP_BASELINE_TRAITS = [
  "active-thread-transcript",
  "composer",
  "run-state-control",
  "model-or-permission-control",
  "plan-or-output-side-panel",
];
const REQUIRED_ACTIVE_EVENT_TYPES = [
  "text",
  "tool-call",
  "tool-result",
  "permission-request",
  "usage",
  "finish",
];
const REQUIRED_VISIBLE_SURFACES = ["events", "sessions", "launch-plan", "ledger"];
const REQUIRED_ASSERTIONS = [
  "Electron preload bridge exposes desktopBridge.getWsUrl",
  "desktopBridge.getWsUrl returns live loopback backend websocket URL",
  "real Node backend responds on /health through desktop bridge URL",
  "Electron process tree contains apps/server/dist backend child process",
  "renderer detected Electron runtime from preload bridge",
  "composer shell mounted from Electron product route",
  "composer attachment control is visible in the running shell",
  "composer model or reasoning control is visible in the running shell",
  "native Moss shell is enabled by explicit harness route under Electron",
  "normalized event subscription is live with fixture events",
  "permission request action shell is available from normalized event",
  "Codex Desktop baseline-backed active shell control set is visible",
  "active normalized timeline covers text, tool, permission, usage, and finish",
  "permission request approve action transitions to accepted",
  "session list surface shows secondary provider session",
  "secondary provider session can be selected without changing the active thread",
  "normalized event surface scopes to selected secondary session",
  "selected secondary session normalized timeline renders without active-thread event bleed",
  "selected secondary session normalized row is visible",
  "selected secondary session timeline hides active-thread and raw provider text",
  "launch plan inspector renders selected secondary redacted plan hash",
  "loop ledger dashboard surface is visible",
  "selected-session event surface remains available after surface switches",
  "Codex Desktop broader interaction path preserves selected-session drilldown",
  "composer and active route remain stable across Moss surface switches",
] as const;

export type MossElectronProductShellSmokeGateIssueCode =
  | "missing-report"
  | "malformed-report"
  | "missing-screenshot"
  | "empty-screenshot"
  | "stale-report-date"
  | "unexpected-route"
  | "unexpected-desktop-runtime"
  | "unexpected-backend-mode"
  | "missing-desktop-bridge"
  | "missing-native-api"
  | "unexpected-runtime-dataset"
  | "backend-health-failed"
  | "missing-backend-process"
  | "missing-assertion"
  | "missing-interaction-continuity"
  | "unexpected-interaction-continuity"
  | "missing-codex-desktop-interaction-acceptance"
  | "unexpected-codex-desktop-interaction-acceptance"
  | "too-few-assertions"
  | "screenshot-path-mismatch";

export interface MossElectronProductShellSmokeGateIssue {
  readonly code: MossElectronProductShellSmokeGateIssueCode;
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossElectronProductShellSmokeGateOptions {
  readonly createdAt?: string;
  readonly reportPath?: string | undefined;
  readonly screenshotPath?: string | undefined;
}

export interface MossElectronProductShellSmokeGateReportSummary {
  readonly createdAt?: string | undefined;
  readonly route?: string | undefined;
  readonly desktopRuntime?: string | undefined;
  readonly backendMode?: string | undefined;
  readonly assertionCount?: number | undefined;
  readonly runtimeDataset?: string | undefined;
  readonly hasDesktopBridge?: boolean | undefined;
  readonly hasNativeApi?: boolean | undefined;
  readonly backendHealthStatus?: number | undefined;
  readonly backendProcessPresent?: boolean | undefined;
  readonly screenshotPath?: string | undefined;
  readonly interactionContinuity?:
    | {
        readonly routeBeforeSwitches?: string | undefined;
        readonly routeAfterSwitches?: string | undefined;
        readonly composerThreadIdAfterSwitches?: string | undefined;
        readonly selectedSessionThreadId?: string | undefined;
        readonly selectedSessionEventCount?: number | undefined;
        readonly permissionActionStatus?: string | undefined;
        readonly launchPlanHashVisible?: string | undefined;
      }
    | undefined;
  readonly codexDesktopInteractionAcceptance?:
    | {
        readonly baselineScreenshotPath?: string | undefined;
        readonly activeThreadId?: string | undefined;
        readonly activeProvider?: string | undefined;
        readonly activeSessionStatus?: string | undefined;
        readonly activeTimelineRowCount?: number | undefined;
        readonly selectedSessionThreadId?: string | undefined;
        readonly selectedSessionEventCount?: number | undefined;
        readonly permissionActionStatus?: string | undefined;
        readonly launchPlanHashVisible?: string | undefined;
        readonly routeBeforeSwitches?: string | undefined;
        readonly routeAfterSwitches?: string | undefined;
        readonly composerThreadIdAfterSwitches?: string | undefined;
        readonly fullCodexParityClaim?: boolean | undefined;
      }
    | undefined;
}

export interface MossElectronProductShellSmokeGateScreenshotSummary {
  readonly path: string;
  readonly bytes?: number | undefined;
}

export interface MossElectronProductShellSmokeGateReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly reportPath: string;
  readonly screenshotPath: string;
  readonly report?: MossElectronProductShellSmokeGateReportSummary | undefined;
  readonly screenshot?: MossElectronProductShellSmokeGateScreenshotSummary | undefined;
  readonly requiredAssertions: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<MossElectronProductShellSmokeGateIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function defaultReportPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-electron-product-shell-smoke-${artifactDate(createdAt)}.json`;
}

function defaultScreenshotPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-electron-product-shell-smoke-${artifactDate(createdAt)}.png`;
}

function resolveRepoPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

function toDisplayPath(cwd: string, inputPath: string): string {
  const resolvedPath = resolveRepoPath(cwd, inputPath);
  const relativePath = relative(cwd, resolvedPath);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath || ".";
  }
  return inputPath;
}

function sameEvidencePath(cwd: string, left: string, right: string): boolean {
  return resolveRepoPath(cwd, left) === resolveRepoPath(cwd, right);
}

function pushIssue(
  issues: MossElectronProductShellSmokeGateIssue[],
  issue: MossElectronProductShellSmokeGateIssue,
): void {
  issues.push(issue);
}

function readSmokeReport(input: {
  readonly cwd: string;
  readonly reportPath: string;
  readonly issues: MossElectronProductShellSmokeGateIssue[];
}): Record<string, unknown> | null {
  const displayPath = toDisplayPath(input.cwd, input.reportPath);
  const absolutePath = resolveRepoPath(input.cwd, input.reportPath);
  if (!existsSync(absolutePath)) {
    pushIssue(input.issues, {
      code: "missing-report",
      severity: "error",
      path: displayPath,
      message: `Electron product-shell smoke report is missing: ${displayPath}.`,
    });
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      throw new Error("report root is not an object");
    }
    return parsed;
  } catch (error) {
    pushIssue(input.issues, {
      code: "malformed-report",
      severity: "error",
      path: displayPath,
      message: `Electron product-shell smoke report is malformed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    });
    return null;
  }
}

function readScreenshotSummary(input: {
  readonly cwd: string;
  readonly screenshotPath: string;
  readonly issues: MossElectronProductShellSmokeGateIssue[];
}): MossElectronProductShellSmokeGateScreenshotSummary {
  const displayPath = toDisplayPath(input.cwd, input.screenshotPath);
  const absolutePath = resolveRepoPath(input.cwd, input.screenshotPath);
  if (!existsSync(absolutePath)) {
    pushIssue(input.issues, {
      code: "missing-screenshot",
      severity: "error",
      path: displayPath,
      message: `Electron product-shell smoke screenshot is missing: ${displayPath}.`,
    });
    return { path: displayPath };
  }

  const bytes = statSync(absolutePath).size;
  if (bytes <= 0) {
    pushIssue(input.issues, {
      code: "empty-screenshot",
      severity: "error",
      path: displayPath,
      message: `Electron product-shell smoke screenshot is empty: ${displayPath}.`,
    });
  }

  return {
    path: displayPath,
    bytes,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function buildReportSummary(
  report: Record<string, unknown>,
): MossElectronProductShellSmokeGateReportSummary {
  const runtimeEvidence = isObject(report.runtimeEvidence) ? report.runtimeEvidence : {};
  const backendHealth = isObject(report.backendHealth) ? report.backendHealth : {};
  const processEvidence = isObject(report.processEvidence) ? report.processEvidence : {};
  const interactionContinuity = isObject(report.interactionContinuity)
    ? report.interactionContinuity
    : undefined;
  const codexDesktopInteractionAcceptance = isObject(report.codexDesktopInteractionAcceptance)
    ? report.codexDesktopInteractionAcceptance
    : undefined;
  const assertions = Array.isArray(report.assertions) ? report.assertions : [];

  return {
    createdAt: stringField(report.createdAt),
    route: stringField(report.route),
    desktopRuntime: stringField(report.desktopRuntime),
    backendMode: stringField(report.backendMode),
    assertionCount: assertions.length,
    runtimeDataset: stringField(runtimeEvidence.runtimeDataset),
    hasDesktopBridge: booleanField(runtimeEvidence.hasDesktopBridge),
    hasNativeApi: booleanField(runtimeEvidence.hasNativeApi),
    backendHealthStatus: numberField(backendHealth.status),
    backendProcessPresent:
      typeof processEvidence.backend === "string" && processEvidence.backend.length > 0,
    screenshotPath: stringField(report.screenshotPath),
    ...(interactionContinuity
      ? {
          interactionContinuity: {
            routeBeforeSwitches: stringField(interactionContinuity.routeBeforeSwitches),
            routeAfterSwitches: stringField(interactionContinuity.routeAfterSwitches),
            composerThreadIdAfterSwitches: stringField(
              interactionContinuity.composerThreadIdAfterSwitches,
            ),
            selectedSessionThreadId: stringField(interactionContinuity.selectedSessionThreadId),
            selectedSessionEventCount: numberField(interactionContinuity.selectedSessionEventCount),
            permissionActionStatus: stringField(interactionContinuity.permissionActionStatus),
            launchPlanHashVisible: stringField(interactionContinuity.launchPlanHashVisible),
          },
        }
      : {}),
    ...(codexDesktopInteractionAcceptance
      ? {
          codexDesktopInteractionAcceptance: {
            baselineScreenshotPath: stringField(
              codexDesktopInteractionAcceptance.baselineScreenshotPath,
            ),
            activeThreadId: stringField(codexDesktopInteractionAcceptance.activeThreadId),
            activeProvider: stringField(codexDesktopInteractionAcceptance.activeProvider),
            activeSessionStatus: stringField(codexDesktopInteractionAcceptance.activeSessionStatus),
            activeTimelineRowCount: numberField(
              codexDesktopInteractionAcceptance.activeTimelineRowCount,
            ),
            selectedSessionThreadId: stringField(
              codexDesktopInteractionAcceptance.selectedSessionThreadId,
            ),
            selectedSessionEventCount: numberField(
              codexDesktopInteractionAcceptance.selectedSessionEventCount,
            ),
            permissionActionStatus: stringField(
              codexDesktopInteractionAcceptance.permissionActionStatus,
            ),
            launchPlanHashVisible: stringField(
              codexDesktopInteractionAcceptance.launchPlanHashVisible,
            ),
            routeBeforeSwitches: stringField(codexDesktopInteractionAcceptance.routeBeforeSwitches),
            routeAfterSwitches: stringField(codexDesktopInteractionAcceptance.routeAfterSwitches),
            composerThreadIdAfterSwitches: stringField(
              codexDesktopInteractionAcceptance.composerThreadIdAfterSwitches,
            ),
            fullCodexParityClaim: booleanField(
              codexDesktopInteractionAcceptance.fullCodexParityClaim,
            ),
          },
        }
      : {}),
  };
}

function validateSmokeReport(input: {
  readonly cwd: string;
  readonly createdAt: string;
  readonly reportPath: string;
  readonly screenshotPath: string;
  readonly report: Record<string, unknown>;
  readonly issues: MossElectronProductShellSmokeGateIssue[];
}): MossElectronProductShellSmokeGateReportSummary {
  const summary = buildReportSummary(input.report);
  const displayReportPath = toDisplayPath(input.cwd, input.reportPath);
  const displayScreenshotPath = toDisplayPath(input.cwd, input.screenshotPath);
  const runtimeEvidence = isObject(input.report.runtimeEvidence)
    ? input.report.runtimeEvidence
    : {};
  const backendHealth = isObject(input.report.backendHealth) ? input.report.backendHealth : {};
  const processEvidence = isObject(input.report.processEvidence)
    ? input.report.processEvidence
    : {};
  const assertions = Array.isArray(input.report.assertions)
    ? input.report.assertions.filter(
        (assertion): assertion is string => typeof assertion === "string",
      )
    : [];
  const assertionSet = new Set(assertions);

  if (!summary.createdAt || artifactDate(summary.createdAt) !== artifactDate(input.createdAt)) {
    pushIssue(input.issues, {
      code: "stale-report-date",
      severity: "error",
      path: displayReportPath,
      message: `Electron product-shell smoke report date must match ${artifactDate(input.createdAt)}.`,
    });
  }

  if (summary.route !== EXPECTED_ROUTE) {
    pushIssue(input.issues, {
      code: "unexpected-route",
      severity: "error",
      path: displayReportPath,
      message: `Electron product-shell smoke route must be ${EXPECTED_ROUTE}.`,
    });
  }

  if (summary.desktopRuntime !== "electron") {
    pushIssue(input.issues, {
      code: "unexpected-desktop-runtime",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke desktopRuntime must be electron.",
    });
  }

  if (summary.backendMode !== "real-node") {
    pushIssue(input.issues, {
      code: "unexpected-backend-mode",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke backendMode must be real-node.",
    });
  }

  if (runtimeEvidence.hasDesktopBridge !== true) {
    pushIssue(input.issues, {
      code: "missing-desktop-bridge",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke must prove desktopBridge is present.",
    });
  }

  if (runtimeEvidence.hasNativeApi !== true) {
    pushIssue(input.issues, {
      code: "missing-native-api",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke must prove nativeApi is present.",
    });
  }

  if (runtimeEvidence.runtimeDataset !== "electron") {
    pushIssue(input.issues, {
      code: "unexpected-runtime-dataset",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke runtime dataset must be electron.",
    });
  }

  if (backendHealth.status !== 200) {
    pushIssue(input.issues, {
      code: "backend-health-failed",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke must prove real Node backend /health returns 200.",
    });
  }

  if (
    typeof processEvidence.backend !== "string" ||
    !(
      processEvidence.backend.includes("apps/server/dist/index.mjs") ||
      processEvidence.backend.includes("apps/server/dist/index.cjs")
    )
  ) {
    pushIssue(input.issues, {
      code: "missing-backend-process",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke must prove apps/server/dist backend child process.",
    });
  }

  if (assertions.length < 33) {
    pushIssue(input.issues, {
      code: "too-few-assertions",
      severity: "error",
      path: displayReportPath,
      message: `Electron product-shell smoke must contain at least 33 assertions, found ${assertions.length}.`,
    });
  }

  for (const assertion of REQUIRED_ASSERTIONS) {
    if (!assertionSet.has(assertion)) {
      pushIssue(input.issues, {
        code: "missing-assertion",
        severity: "error",
        path: displayReportPath,
        message: `Electron product-shell smoke is missing required assertion: ${assertion}.`,
      });
    }
  }

  const interactionContinuity = isObject(input.report.interactionContinuity)
    ? input.report.interactionContinuity
    : null;
  if (!interactionContinuity) {
    pushIssue(input.issues, {
      code: "missing-interaction-continuity",
      severity: "error",
      path: displayReportPath,
      message: "Electron product-shell smoke must include interactionContinuity evidence.",
    });
  } else {
    const visitedSurfaces = Array.isArray(interactionContinuity.visitedSurfaces)
      ? interactionContinuity.visitedSurfaces.filter(
          (surface): surface is string => typeof surface === "string",
        )
      : [];
    const missingSurfaces = ["events", "sessions", "launch-plan", "ledger"].filter(
      (surface) => !visitedSurfaces.includes(surface),
    );
    const invalidFields = [
      stringField(interactionContinuity.routeBeforeSwitches) !== EXPECTED_ROUTE
        ? "routeBeforeSwitches"
        : null,
      stringField(interactionContinuity.routeAfterSwitches) !== EXPECTED_ROUTE
        ? "routeAfterSwitches"
        : null,
      stringField(interactionContinuity.composerThreadIdAfterSwitches) !== EXPECTED_ACTIVE_THREAD_ID
        ? "composerThreadIdAfterSwitches"
        : null,
      stringField(interactionContinuity.selectedSessionThreadId) !== EXPECTED_SELECTED_THREAD_ID
        ? "selectedSessionThreadId"
        : null,
      numberField(interactionContinuity.selectedSessionEventCount) !== 1
        ? "selectedSessionEventCount"
        : null,
      stringField(interactionContinuity.permissionActionStatus) !== "accepted"
        ? "permissionActionStatus"
        : null,
      stringField(interactionContinuity.launchPlanHashVisible) !==
      EXPECTED_SELECTED_LAUNCH_PLAN_HASH
        ? "launchPlanHashVisible"
        : null,
      missingSurfaces.length > 0 ? `visitedSurfaces:${missingSurfaces.join(",")}` : null,
    ].filter((field): field is string => Boolean(field));

    if (invalidFields.length > 0) {
      pushIssue(input.issues, {
        code: "unexpected-interaction-continuity",
        severity: "error",
        path: displayReportPath,
        message: `Electron product-shell smoke interactionContinuity is invalid: ${invalidFields.join(
          ", ",
        )}.`,
      });
    }
  }

  const codexDesktopInteractionAcceptance = isObject(input.report.codexDesktopInteractionAcceptance)
    ? input.report.codexDesktopInteractionAcceptance
    : null;
  if (!codexDesktopInteractionAcceptance) {
    pushIssue(input.issues, {
      code: "missing-codex-desktop-interaction-acceptance",
      severity: "error",
      path: displayReportPath,
      message:
        "Electron product-shell smoke must include codexDesktopInteractionAcceptance evidence.",
    });
  } else {
    const baselineTraits = Array.isArray(codexDesktopInteractionAcceptance.baselineTraits)
      ? codexDesktopInteractionAcceptance.baselineTraits.filter(
          (trait): trait is string => typeof trait === "string",
        )
      : [];
    const missingBaselineTraits = REQUIRED_CODEX_DESKTOP_BASELINE_TRAITS.filter(
      (trait) => !baselineTraits.includes(trait),
    );
    const visibleSurfaceIds = Array.isArray(codexDesktopInteractionAcceptance.visibleSurfaceIds)
      ? codexDesktopInteractionAcceptance.visibleSurfaceIds.filter(
          (surface): surface is string => typeof surface === "string",
        )
      : [];
    const missingSurfaces = REQUIRED_VISIBLE_SURFACES.filter(
      (surface) => !visibleSurfaceIds.includes(surface),
    );
    const activeEventTypes = Array.isArray(codexDesktopInteractionAcceptance.activeEventTypes)
      ? codexDesktopInteractionAcceptance.activeEventTypes.filter(
          (eventType): eventType is string => typeof eventType === "string",
        )
      : [];
    const missingActiveEventTypes = REQUIRED_ACTIVE_EVENT_TYPES.filter(
      (eventType) => !activeEventTypes.includes(eventType),
    );
    const composerControls = isObject(codexDesktopInteractionAcceptance.composerControls)
      ? codexDesktopInteractionAcceptance.composerControls
      : {};
    const normalizedTimeline = isObject(codexDesktopInteractionAcceptance.normalizedTimeline)
      ? codexDesktopInteractionAcceptance.normalizedTimeline
      : {};
    const invalidFields = [
      stringField(codexDesktopInteractionAcceptance.baselineScreenshotPath) !==
      EXPECTED_CODEX_DESKTOP_BASELINE_SCREENSHOT
        ? "baselineScreenshotPath"
        : null,
      missingBaselineTraits.length > 0 ? `baselineTraits:${missingBaselineTraits.join(",")}` : null,
      stringField(codexDesktopInteractionAcceptance.activeThreadId) !== EXPECTED_ACTIVE_THREAD_ID
        ? "activeThreadId"
        : null,
      stringField(codexDesktopInteractionAcceptance.activeProvider) !== "codex"
        ? "activeProvider"
        : null,
      stringField(codexDesktopInteractionAcceptance.activeSessionStatus) !== "running"
        ? "activeSessionStatus"
        : null,
      numberField(codexDesktopInteractionAcceptance.activeTimelineRowCount) !== 8
        ? "activeTimelineRowCount"
        : null,
      missingSurfaces.length > 0 ? `visibleSurfaceIds:${missingSurfaces.join(",")}` : null,
      missingActiveEventTypes.length > 0
        ? `activeEventTypes:${missingActiveEventTypes.join(",")}`
        : null,
      booleanField(composerControls.composerShell) !== true
        ? "composerControls.composerShell"
        : null,
      booleanField(composerControls.attachment) !== true ? "composerControls.attachment" : null,
      booleanField(composerControls.modelOrReasoning) !== true
        ? "composerControls.modelOrReasoning"
        : null,
      booleanField(composerControls.stop) !== true ? "composerControls.stop" : null,
      booleanField(normalizedTimeline.toolLifecycle) !== true
        ? "normalizedTimeline.toolLifecycle"
        : null,
      booleanField(normalizedTimeline.permissionAction) !== true
        ? "normalizedTimeline.permissionAction"
        : null,
      booleanField(normalizedTimeline.usage) !== true ? "normalizedTimeline.usage" : null,
      booleanField(normalizedTimeline.finish) !== true ? "normalizedTimeline.finish" : null,
      booleanField(codexDesktopInteractionAcceptance.rawProviderSourceHidden) !== true
        ? "rawProviderSourceHidden"
        : null,
      stringField(codexDesktopInteractionAcceptance.routeBeforeSwitches) !== EXPECTED_ROUTE
        ? "routeBeforeSwitches"
        : null,
      stringField(codexDesktopInteractionAcceptance.routeAfterSwitches) !== EXPECTED_ROUTE
        ? "routeAfterSwitches"
        : null,
      stringField(codexDesktopInteractionAcceptance.composerThreadIdAfterSwitches) !==
      EXPECTED_ACTIVE_THREAD_ID
        ? "composerThreadIdAfterSwitches"
        : null,
      stringField(codexDesktopInteractionAcceptance.selectedSessionThreadId) !==
      EXPECTED_SELECTED_THREAD_ID
        ? "selectedSessionThreadId"
        : null,
      numberField(codexDesktopInteractionAcceptance.selectedSessionEventCount) !== 1
        ? "selectedSessionEventCount"
        : null,
      stringField(codexDesktopInteractionAcceptance.permissionActionStatus) !== "accepted"
        ? "permissionActionStatus"
        : null,
      stringField(codexDesktopInteractionAcceptance.launchPlanHashVisible) !==
      EXPECTED_SELECTED_LAUNCH_PLAN_HASH
        ? "launchPlanHashVisible"
        : null,
      booleanField(codexDesktopInteractionAcceptance.fullCodexParityClaim) !== false
        ? "fullCodexParityClaim"
        : null,
    ].filter((field): field is string => Boolean(field));

    if (invalidFields.length > 0) {
      pushIssue(input.issues, {
        code: "unexpected-codex-desktop-interaction-acceptance",
        severity: "error",
        path: displayReportPath,
        message: `Electron product-shell smoke codexDesktopInteractionAcceptance is invalid: ${invalidFields.join(
          ", ",
        )}.`,
      });
    }
  }

  if (
    typeof input.report.screenshotPath === "string" &&
    !sameEvidencePath(input.cwd, input.report.screenshotPath, input.screenshotPath)
  ) {
    pushIssue(input.issues, {
      code: "screenshot-path-mismatch",
      severity: "error",
      path: displayReportPath,
      message: `Electron product-shell smoke report screenshotPath must match ${displayScreenshotPath}.`,
    });
  }

  return summary;
}

export function readMossElectronProductShellSmokeGate(
  cwd = process.cwd(),
  options: MossElectronProductShellSmokeGateOptions = {},
): MossElectronProductShellSmokeGateReport {
  const generatedAt = options.createdAt ?? new Date().toISOString();
  const reportPath = options.reportPath ?? defaultReportPath(generatedAt);
  const screenshotPath = options.screenshotPath ?? defaultScreenshotPath(generatedAt);
  const displayReportPath = toDisplayPath(cwd, reportPath);
  const displayScreenshotPath = toDisplayPath(cwd, screenshotPath);
  const issues: MossElectronProductShellSmokeGateIssue[] = [];
  const screenshot = readScreenshotSummary({ cwd, screenshotPath, issues });
  const rawReport = readSmokeReport({ cwd, reportPath, issues });
  const report = rawReport
    ? validateSmokeReport({
        cwd,
        createdAt: generatedAt,
        reportPath,
        screenshotPath,
        report: rawReport,
        issues,
      })
    : undefined;
  const status = issues.length === 0 ? "pass" : "fail";

  return {
    version: 1,
    generatedAt,
    reportPath: displayReportPath,
    screenshotPath: displayScreenshotPath,
    ...(report ? { report } : {}),
    screenshot,
    requiredAssertions: [...REQUIRED_ASSERTIONS],
    issues,
    readiness: {
      status,
      summary:
        status === "pass"
          ? `Electron product-shell smoke evidence is release-ready: ${displayReportPath}.`
          : `Electron product-shell smoke evidence has ${issues.length} issue(s).`,
    },
  };
}

export function mossElectronProductShellSmokeGateExitCode(
  report: MossElectronProductShellSmokeGateReport,
): number {
  return report.readiness.status === "pass" ? 0 : 1;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossElectronProductShellSmokeGateOptions {
  const options: {
    createdAt?: string;
    reportPath?: string;
    screenshotPath?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    if (arg === "--report") {
      const reportPath = argv[index + 1];
      if (!reportPath) {
        throw new Error("--report requires a repo-local smoke report path");
      }
      options.reportPath = reportPath;
      index += 1;
      continue;
    }
    if (arg === "--screenshot") {
      const screenshotPath = argv[index + 1];
      if (!screenshotPath) {
        throw new Error("--screenshot requires a repo-local screenshot path");
      }
      options.screenshotPath = screenshotPath;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function main(argv: ReadonlyArray<string>): number {
  const report = readMossElectronProductShellSmokeGate(process.cwd(), parseCliOptions(argv));
  console.log(JSON.stringify(report, null, 2));
  return mossElectronProductShellSmokeGateExitCode(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
