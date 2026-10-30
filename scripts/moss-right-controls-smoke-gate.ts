import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const EXPECTED_ROUTE = "moss://app/index.html#/thread-moss-served-smoke?mossShell=1";
const REQUIRED_STATE_IDS = [
  "closed-overlay",
  "summary-overlay-open",
  "summary-create-document-draft",
  "bottom-x-preserves-tab",
  "bottom-drawer",
  "bottom-height-behavior",
  "right-regular",
  "right-full-width",
  "summary-inline-pinned",
] as const;

export type MossRightControlsSmokeGateIssueCode =
  | "missing-report"
  | "malformed-report"
  | "smoke-failed"
  | "stale-report-date"
  | "unexpected-route"
  | "unexpected-runtime"
  | "missing-state"
  | "unexpected-state"
  | "duplicate-state"
  | "failed-state"
  | "missing-check"
  | "failed-check"
  | "missing-screenshot"
  | "empty-screenshot";

export interface MossRightControlsSmokeGateIssue {
  readonly code: MossRightControlsSmokeGateIssueCode;
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly stateId?: string | undefined;
  readonly checkId?: string | undefined;
  readonly message: string;
}

export interface MossRightControlsSmokeGateOptions {
  readonly createdAt?: string | undefined;
  readonly reportPath?: string | undefined;
}

export interface MossRightControlsSmokeGateReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly reportPath: string;
  readonly requiredStateIds: ReadonlyArray<string>;
  readonly observedStateIds: ReadonlyArray<string>;
  readonly screenshotPaths: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<MossRightControlsSmokeGateIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

function defaultReportPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-right-controls-smoke-${datePart(createdAt)}.json`;
}

function displayPath(cwd: string, inputPath: string): string {
  const absolute = resolve(cwd, inputPath);
  const local = relative(cwd, absolute);
  return !local.startsWith("..") && !isAbsolute(local) ? local || "." : inputPath;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredCheckIds(stateId: string): string[] {
  const ids =
    stateId === "right-full-width"
      ? []
      : [
          "fixed-controls-container-count",
          "fixed-controls-only",
          "fixed-controls-order",
          "fixed-controls-size",
          "fixed-controls-baseline",
          "bottom-chinese-label",
          "bottom-chinese-title",
          "summary-chinese-label",
          "summary-chinese-title",
          "right-chinese-label",
          "right-chinese-title",
        ];
  if (stateId === "closed-overlay") {
    ids.push("summary-hidden", "bottom-closed", "right-closed");
  }
  if (stateId === "summary-overlay-open") {
    ids.push("summary-overlay-visible", "summary-panel-width", "summary-pressed");
  }
  if (stateId === "summary-create-document-draft") {
    ids.push(
      "summary-document-prompt-exact",
      "summary-document-editor-focused",
      "summary-document-caret-at-end",
      "summary-document-not-submitted",
    );
  }
  if (stateId === "bottom-x-preserves-tab") {
    ids.push(
      "bottom-x-closes-drawer",
      "bottom-x-preserves-terminal-ids",
      "bottom-x-preserves-active-terminal",
      "bottom-x-preserves-terminal-groups",
      "bottom-x-reopens-same-tab",
    );
  }
  if (stateId === "bottom-drawer") {
    ids.push(
      "bottom-pressed",
      "drawer-visible",
      "drawer-height",
      "drawer-single-tab",
      "drawer-single-plus",
      "drawer-single-close",
      "drawer-only-tab-plus-close",
      "drawer-no-workspace-actions",
      "drawer-no-runtime-error",
      "drawer-motion-contract",
      "bottom-shortcut-opens",
      "bottom-shortcut-closes",
      "bottom-shortcut-reopens",
    );
  }
  if (stateId === "bottom-height-behavior") {
    ids.push(
      "bottom-resize-height",
      "bottom-resize-storage",
      "bottom-resize-thread-state",
      "bottom-resize-reopens-persisted",
      "bottom-under-min-closes",
      "bottom-under-min-keeps-storage",
      "bottom-under-min-reopens-persisted",
    );
  }
  if (stateId === "right-regular") {
    ids.push(
      "right-pressed",
      "right-dock-visible",
      "right-dock-no-fixed-control-duplicates",
      "right-dock-motion-contract",
      "right-shortcut-opens",
      "right-shortcut-closes",
      "right-shortcut-reopens",
    );
  }
  if (stateId === "right-full-width") {
    ids.push(
      "right-full-width-fills-shell",
      "right-full-width-no-divider",
      "right-full-width-no-resizer",
      "right-full-width-main-header-hidden",
      "right-full-width-replacement-controls-only",
      "right-full-width-bottom-control-works",
      "right-full-width-bottom-panel-normal-flow",
      "right-full-width-bottom-panel-compresses-shell-row",
      "right-full-width-collapse-control-works",
      "right-full-width-restores-after-reopen",
    );
  }
  if (stateId === "summary-inline-pinned") {
    ids.push("summary-inline-visible", "summary-panel-width", "summary-pressed");
  }
  return ids.map((id) => `${stateId}:${id}`);
}

function normalizeRoute(value: string | undefined): string | undefined {
  return value?.replace("#/", "#/");
}

export function readMossRightControlsSmokeGate(
  cwd: string,
  options: MossRightControlsSmokeGateOptions = {},
): MossRightControlsSmokeGateReport {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const reportPath = options.reportPath ?? defaultReportPath(createdAt);
  const shownReportPath = displayPath(cwd, reportPath);
  const issues: MossRightControlsSmokeGateIssue[] = [];
  const screenshotPaths: string[] = [];
  let report: Record<string, unknown> | null = null;

  const absoluteReportPath = resolve(cwd, reportPath);
  if (!existsSync(absoluteReportPath)) {
    issues.push({
      code: "missing-report",
      severity: "error",
      path: shownReportPath,
      message: `Right-controls smoke report is missing: ${shownReportPath}.`,
    });
  } else {
    try {
      const parsed = JSON.parse(readFileSync(absoluteReportPath, "utf8")) as unknown;
      if (!isObject(parsed)) throw new Error("report root is not an object");
      report = parsed;
    } catch (error) {
      issues.push({
        code: "malformed-report",
        severity: "error",
        path: shownReportPath,
        message: `Right-controls smoke report is malformed: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      });
    }
  }

  const observedStateIds: string[] = [];
  if (report) {
    if (report.status !== "pass") {
      issues.push({
        code: "smoke-failed",
        severity: "error",
        path: shownReportPath,
        message: "Right-controls Electron smoke did not report pass.",
      });
    }
    const reportCreatedAt = stringField(report.createdAt);
    if (!reportCreatedAt || datePart(reportCreatedAt) !== datePart(createdAt)) {
      issues.push({
        code: "stale-report-date",
        severity: "error",
        path: shownReportPath,
        message: `Right-controls smoke date must match ${datePart(createdAt)}.`,
      });
    }
    if (normalizeRoute(stringField(report.route)) !== EXPECTED_ROUTE) {
      issues.push({
        code: "unexpected-route",
        severity: "error",
        path: shownReportPath,
        message: `Right-controls smoke route must be ${EXPECTED_ROUTE}.`,
      });
    }
    const runtime = isObject(report.runtime) ? report.runtime : {};
    if (
      runtime.runtimeDataset !== "electron" ||
      runtime.hasDesktopBridge !== true ||
      runtime.hasNativeApi !== true
    ) {
      issues.push({
        code: "unexpected-runtime",
        severity: "error",
        path: shownReportPath,
        message:
          "Right-controls smoke must run in Electron with desktopBridge, nativeApi, and runtime dataset evidence.",
      });
    }

    const states = Array.isArray(report.states) ? report.states.filter(isObject) : [];
    const stateById = new Map<string, Record<string, unknown>>();
    for (const state of states) {
      const stateId = stringField(state.id);
      if (!stateId) continue;
      observedStateIds.push(stateId);
      if (!(REQUIRED_STATE_IDS as ReadonlyArray<string>).includes(stateId)) {
        issues.push({
          code: "unexpected-state",
          severity: "error",
          stateId,
          path: shownReportPath,
          message: `Right-controls smoke contains an out-of-scope state: ${stateId}.`,
        });
      }
      if (stateById.has(stateId)) {
        issues.push({
          code: "duplicate-state",
          severity: "error",
          stateId,
          path: shownReportPath,
          message: `Right-controls smoke state is duplicated: ${stateId}.`,
        });
      }
      stateById.set(stateId, state);
    }

    for (const stateId of REQUIRED_STATE_IDS) {
      const state = stateById.get(stateId);
      if (!state) {
        issues.push({
          code: "missing-state",
          severity: "error",
          stateId,
          path: shownReportPath,
          message: `Right-controls smoke is missing state: ${stateId}.`,
        });
        continue;
      }
      if (state.status !== "pass") {
        issues.push({
          code: "failed-state",
          severity: "error",
          stateId,
          path: shownReportPath,
          message: `Right-controls smoke state did not pass: ${stateId}.`,
        });
      }
      const checks = Array.isArray(state.checks) ? state.checks.filter(isObject) : [];
      const checkById = new Map(
        checks
          .map((entry) => [stringField(entry.id), entry] as const)
          .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])),
      );
      for (const checkId of requiredCheckIds(stateId)) {
        const check = checkById.get(checkId);
        if (!check) {
          issues.push({
            code: "missing-check",
            severity: "error",
            stateId,
            checkId,
            path: shownReportPath,
            message: `Right-controls smoke is missing check: ${checkId}.`,
          });
        } else if (check.pass !== true) {
          issues.push({
            code: "failed-check",
            severity: "error",
            stateId,
            checkId,
            path: shownReportPath,
            message: `Right-controls smoke check failed: ${checkId}.`,
          });
        }
      }

      const screenshotPath = stringField(state.screenshotPath);
      if (!screenshotPath) {
        issues.push({
          code: "missing-screenshot",
          severity: "error",
          stateId,
          path: shownReportPath,
          message: `Right-controls state has no screenshot path: ${stateId}.`,
        });
        continue;
      }
      const shownScreenshotPath = displayPath(cwd, screenshotPath);
      screenshotPaths.push(shownScreenshotPath);
      const absoluteScreenshotPath = resolve(cwd, screenshotPath);
      if (!existsSync(absoluteScreenshotPath)) {
        issues.push({
          code: "missing-screenshot",
          severity: "error",
          stateId,
          path: shownScreenshotPath,
          message: `Right-controls state screenshot is missing: ${shownScreenshotPath}.`,
        });
      } else if (statSync(absoluteScreenshotPath).size <= 0) {
        issues.push({
          code: "empty-screenshot",
          severity: "error",
          stateId,
          path: shownScreenshotPath,
          message: `Right-controls state screenshot is empty: ${shownScreenshotPath}.`,
        });
      }
    }
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    version: 1,
    generatedAt: createdAt,
    reportPath: shownReportPath,
    requiredStateIds: REQUIRED_STATE_IDS,
    observedStateIds,
    screenshotPaths,
    issues,
    readiness: {
      status,
      summary:
        status === "pass"
          ? "Moss fixed bottom-summary-right controls, Chinese labels, summary modes, regular dock deduplication, and minimal drawer chrome pass."
          : `Right-controls smoke gate failed with ${issues.length} issue(s).`,
    },
  };
}

export function mossRightControlsSmokeGateExitCode(
  report: MossRightControlsSmokeGateReport,
): 0 | 1 {
  return report.readiness.status === "pass" ? 0 : 1;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossRightControlsSmokeGateOptions {
  const options: { createdAt?: string; reportPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--created-at" && next) {
      options.createdAt = next;
      index += 1;
      continue;
    }
    if (arg === "--report" && next) {
      options.reportPath = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown right-controls smoke-gate option: ${arg}`);
  }
  return options;
}

function main(argv: ReadonlyArray<string>): number {
  const report = readMossRightControlsSmokeGate(process.cwd(), parseCliOptions(argv));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return mossRightControlsSmokeGateExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
