export type MossReleaseGateId =
  | "ledger-status"
  | "provider-fixture-replay"
  | "provider-discovery-smoke"
  | "control-plane-ui-smoke"
  | "electron-product-shell-smoke"
  | "codex-desktop-layout-gate"
  | "release-freshness-refresh-plan-report-index"
  | "loop-packet-freshness-report-index"
  | "loop-packet-refresh-plan-report-index"
  | "loop-packet"
  | "release-gate-report-index"
  | "format-check"
  | "full-typecheck"
  | "lint"
  | "diff-hygiene";

export interface MossReleaseGateCommand {
  readonly id: MossReleaseGateId;
  readonly description: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly expectedEvidence: ReadonlyArray<string>;
  readonly providerCredentialsRequired: false;
  readonly writesGlobalConfig: false;
}

export interface MossReleaseGateManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly gates: ReadonlyArray<MossReleaseGateCommand>;
}

export interface MossReleaseGateOptions {
  readonly createdAt?: string;
}

export interface MossReleaseGateReportIndexObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly manifestGateCount: number;
  readonly manifestGateIds: ReadonlyArray<string>;
  readonly latestArtifactPath?: string | undefined;
  readonly latestArtifactCreatedAt?: string | undefined;
  readonly latestArtifactStatus?: "pass" | "fail" | undefined;
  readonly latestArtifactGateCount?: number | undefined;
  readonly latestArtifactGateIds?: ReadonlyArray<string> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
  readonly staleArtifactMessages: ReadonlyArray<string>;
}

function gate(
  input: Omit<MossReleaseGateCommand, "providerCredentialsRequired" | "writesGlobalConfig">,
) {
  return {
    ...input,
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
  } as const satisfies MossReleaseGateCommand;
}

export function buildMossReleaseGateManifest(
  options: MossReleaseGateOptions = {},
): MossReleaseGateManifest {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    version: 1,
    createdAt,
    gates: [
      gate({
        id: "ledger-status",
        description: "Validate Moss ledger consistency and active-task release status.",
        command: "bun",
        args: ["run", "moss:status"],
        expectedEvidence: ["moss-loop-status JSON with releaseGate.status=pass"],
      }),
      gate({
        id: "provider-fixture-replay",
        description:
          "Replay all seven checked-in provider runtime fixtures (Codex, Claude Agent, Cursor, Gemini, Grok, OpenCode, Pi) into normalized events.",
        command: "bun",
        args: ["run", "moss:provider-replay"],
        expectedEvidence: [".moss/ledger/evidence/provider-fixture-replay-2026-07-01.md"],
      }),
      gate({
        id: "provider-discovery-smoke",
        description:
          "Validate provider discovery capabilities, listSkills, listPlugins, and listModels smoke evidence across the Moss provider discovery service boundary.",
        command: "bun",
        args: ["run", "moss:provider-discovery-smoke-gate", "--", "--created-at", createdAt],
        expectedEvidence: [
          "Provider discovery smoke gate JSON with readiness.status=pass",
          `.moss/ledger/evidence/moss-provider-discovery-smoke-${createdAt.slice(0, 10)}.json`,
        ],
      }),
      gate({
        id: "control-plane-ui-smoke",
        description:
          "Run Moss Control panel browser smoke, timeline hook smoke, unit tests, and web typecheck.",
        command: "bun",
        args: ["run", "moss:ui-smoke"],
        expectedEvidence: [
          ".moss/ledger/evidence/moss-control-plane-ui-smoke-aggregate-2026-07-01.md",
        ],
      }),
      gate({
        id: "electron-product-shell-smoke",
        description:
          "Validate the latest Electron desktop product-shell smoke report and screenshot before release-readiness gates continue.",
        command: "bun",
        args: ["run", "moss:electron-product-shell-smoke-gate", "--", "--created-at", createdAt],
        expectedEvidence: [
          "Electron product-shell smoke gate JSON with readiness.status=pass",
          `.moss/ledger/evidence/moss-electron-product-shell-smoke-${createdAt.slice(0, 10)}.json`,
          `.moss/ledger/evidence/moss-electron-product-shell-smoke-${createdAt.slice(0, 10)}.png`,
        ],
      }),
      gate({
        id: "codex-desktop-layout-gate",
        description:
          "Validate the latest Codex Desktop comparator first-screen layout metrics before release-readiness gates continue.",
        command: "bun",
        args: ["run", "moss:codex-desktop-layout-gate", "--", "--created-at", createdAt],
        expectedEvidence: [
          "Codex Desktop layout gate JSON with readiness.status=pass",
          ".moss/codex-desktop-comparator.json with layoutMetrics and layoutGateStatus=pass",
          "layoutMetrics.mossElectron.evidence JSON/PNG paths referenced by the comparator",
        ],
      }),
      gate({
        id: "release-freshness-refresh-plan-report-index",
        description:
          "Validate the latest compact Moss release freshness refresh plan report before release-readiness gates continue.",
        command: "bun",
        args: [
          "run",
          "moss:release-freshness-refresh-plan-report-index",
          "--",
          "--created-at",
          createdAt,
        ],
        expectedEvidence: [
          "release freshness refresh plan report index JSON with readiness.status=pass",
          ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
        ],
      }),
      gate({
        id: "loop-packet-freshness-report-index",
        description:
          "Validate the latest compact Moss loop packet freshness gate report before release-readiness gates continue.",
        command: "bun",
        args: ["run", "moss:loop-packet-freshness-report-index", "--", "--created-at", createdAt],
        expectedEvidence: [
          "loop packet freshness gate report index JSON with readiness.status=pass",
          ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
        ],
      }),
      gate({
        id: "loop-packet-refresh-plan-report-index",
        description:
          "Validate the latest compact Moss loop packet refresh plan gate report before release-readiness gates continue.",
        command: "bun",
        args: [
          "run",
          "moss:loop-packet-refresh-plan-report-index",
          "--",
          "--created-at",
          createdAt,
        ],
        expectedEvidence: [
          "loop packet refresh plan gate report index JSON with readiness.status=pass",
          ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        ],
      }),
      gate({
        id: "loop-packet",
        description:
          "Generate the aggregate iteration, review, and memory packet for the active Moss task.",
        command: "bun",
        args: ["run", "moss:loop-packet", "--", "--created-at", createdAt],
        expectedEvidence: ["loop packet JSON with readiness.status not blocked"],
      }),
      gate({
        id: "release-gate-report-index",
        description:
          "Validate the latest compact Moss release gate report artifact before release-readiness gates continue.",
        command: "bun",
        args: ["run", "moss:release-gate-report-index", "--", "--created-at", createdAt],
        expectedEvidence: [
          "release gate report artifact index JSON with readiness.status=pass",
          ".moss/ledger/evidence/moss-release-gate-report-index-2026-07-01.md",
        ],
      }),
      gate({
        id: "format-check",
        description: "Check repository formatting without modifying files.",
        command: "bun",
        args: ["run", "fmt:check"],
        expectedEvidence: ["oxfmt --check reports all matched files use the correct format"],
      }),
      gate({
        id: "full-typecheck",
        description: "Run full monorepo typecheck.",
        command: "bun",
        args: ["run", "typecheck"],
        expectedEvidence: ["turbo typecheck completes successfully"],
      }),
      gate({
        id: "lint",
        description: "Run lint with unused-disable reporting.",
        command: "bun",
        args: ["run", "lint"],
        expectedEvidence: ["oxlint exits with 0 errors"],
      }),
      gate({
        id: "diff-hygiene",
        description: "Reject whitespace errors in the current diff.",
        command: "git",
        args: ["diff", "--check"],
        expectedEvidence: ["git diff --check exits with 0"],
      }),
    ],
  };
}
