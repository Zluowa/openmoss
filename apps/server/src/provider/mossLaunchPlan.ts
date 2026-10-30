import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import type {
  MossConfigEntry,
  MossConfigSource,
  MossLaunchPlan,
  MossLaunchPlanEnvironmentVariable,
  MossProjectionResult,
  MossToolPolicy,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  ProviderSessionStartInput,
} from "@synara/contracts";
import {
  hashMossProjectionValue,
  parseMossCanonicalConfig,
  projectAllMossConfig,
} from "@synara/shared/mossConfigProjection";
import { isProviderKind } from "@synara/shared/providerInstances";
import { MOSS_RELATIVE_PATHS, getMossSourceLayout } from "@synara/shared/mossSourceLayout";

const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|auth|token|secret|password|cookie|credential)/i;
const AUDITED_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "NODE_OPTIONS",
  "MOSS_HOME",
  "T3CODE_HOME",
  "DPCODE_HOME",
]);
const AUDITED_ENV_PREFIXES = [
  "MOSS_",
  "T3CODE_",
  "DPCODE_",
  "CODEX_",
  "CLAUDE_",
  "ANTHROPIC_",
  "OPENAI_",
  "GEMINI_",
  "GOOGLE_",
  "CURSOR_",
  "HERMES_",
  "ACP_",
];
const EMPTY_TOOL_POLICY: MossToolPolicy = {
  allow: [],
  deny: [],
};

function shouldAuditEnvKey(key: string): boolean {
  return (
    AUDITED_ENV_KEYS.has(key) ||
    AUDITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    SENSITIVE_KEY_PATTERN.test(key)
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function redactUnknown(value: unknown, path: ReadonlyArray<string> = []): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactUnknown(item, [...path, String(index)]));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[redacted]"
      : redactUnknown(entry, [...path, key]);
  }
  return output;
}

function redactRecord(value: unknown): Record<string, unknown> | undefined {
  const redacted = redactUnknown(value);
  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : undefined;
}

function redactConfigEntry(entry: MossConfigEntry): MossConfigEntry {
  const metadata = entry.metadata ? redactRecord(entry.metadata) : undefined;
  return {
    name: entry.name,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function redactConfigEntries(
  entries: ReadonlyArray<MossConfigEntry>,
): ReadonlyArray<MossConfigEntry> {
  return entries.map((entry) => redactConfigEntry(entry));
}

function launchPlanEnv(env: NodeJS.ProcessEnv): ReadonlyArray<MossLaunchPlanEnvironmentVariable> {
  return Object.entries(env)
    .filter(
      ([key, value]) => value !== undefined && value.trim().length > 0 && shouldAuditEnvKey(key),
    )
    .map(([key, value]) => ({
      key,
      redacted: SENSITIVE_KEY_PATTERN.test(key),
      valueHash: hashValue(value),
      source: "process.env",
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

function inferApprovalPolicy(input: ProviderSessionStartInput): ProviderApprovalPolicy {
  if (input.approvalPolicy) {
    return input.approvalPolicy;
  }
  return input.runtimeMode === "approval-required" ? "on-request" : "never";
}

function inferSandboxMode(input: ProviderSessionStartInput): ProviderSandboxMode {
  if (input.sandboxMode) {
    return input.sandboxMode;
  }
  return input.runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}

function projectionResultHash(projection: MossProjectionResult): string {
  return hashMossProjectionValue({
    target: projection.target,
    outputPath: projection.outputPath ?? null,
    rendered: projection.rendered,
    warnings: projection.warnings,
    writes: projection.writes,
  });
}

function projectionConfigSource(projection: MossProjectionResult): MossConfigSource {
  return {
    kind: "generated",
    ...(projection.outputPath ? { path: projection.outputPath } : {}),
    required: false,
    hash: projectionResultHash(projection),
  };
}

function projectionWarningText(projection: MossProjectionResult): ReadonlyArray<string> {
  return projection.warnings.map((entry) => {
    const path = entry.path ? ` (${entry.path})` : "";
    return `${projection.target}:${entry.code}: ${entry.message}${path}`;
  });
}

export interface MossLaunchPlanCanonicalProjection {
  readonly configSources: ReadonlyArray<MossConfigSource>;
  readonly mcp: ReadonlyArray<MossConfigEntry>;
  readonly skills: ReadonlyArray<MossConfigEntry>;
  readonly memory: ReadonlyArray<MossConfigEntry>;
  readonly hooks: ReadonlyArray<MossConfigEntry>;
  readonly tools: MossToolPolicy;
  readonly projectionWarnings: ReadonlyArray<string>;
}

export interface LoadMossLaunchPlanCanonicalProjectionInput {
  readonly cwd?: string;
  readonly createdAt?: string;
}

function emptyCanonicalProjection(
  source: MossConfigSource,
  projectionWarnings: ReadonlyArray<string>,
): MossLaunchPlanCanonicalProjection {
  return {
    configSources: [source],
    mcp: [],
    skills: [],
    memory: [],
    hooks: [],
    tools: EMPTY_TOOL_POLICY,
    projectionWarnings,
  };
}

export async function loadMossLaunchPlanCanonicalProjection({
  cwd = process.cwd(),
  createdAt = new Date().toISOString(),
}: LoadMossLaunchPlanCanonicalProjectionInput = {}): Promise<MossLaunchPlanCanonicalProjection> {
  const root = cwd.trim().length > 0 ? cwd : process.cwd();
  const sourcePath = getMossSourceLayout(root).workspaceConfig;
  const displayPath = relative(root, sourcePath) || MOSS_RELATIVE_PATHS.workspaceConfig;
  const canonicalSource: MossConfigSource = {
    kind: "canonical",
    path: displayPath,
    required: false,
  };

  let content: string;
  try {
    content = await readFile(sourcePath, "utf8");
  } catch (error) {
    const warning = isNodeErrorWithCode(error, "ENOENT")
      ? `canonical-config-missing: ${displayPath} not found; launch will use provider start input only`
      : `canonical-config-unreadable: ${displayPath} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`;
    return emptyCanonicalProjection(canonicalSource, [warning]);
  }

  try {
    const config = parseMossCanonicalConfig(content, displayPath);
    const projections = projectAllMossConfig(config, {
      dryRun: true,
      createdAt,
      outputRoot: MOSS_RELATIVE_PATHS.projectionsRoot,
    });
    const sourceHash = projections[0]?.sourceHash ?? hashMossProjectionValue(config);
    return {
      configSources: [
        {
          ...canonicalSource,
          hash: sourceHash,
        },
        ...projections.map((projection) => projectionConfigSource(projection)),
      ],
      mcp: redactConfigEntries(config.mcp),
      skills: redactConfigEntries(config.skills),
      memory: redactConfigEntries(config.memory),
      hooks: redactConfigEntries(config.hooks),
      tools: config.tools,
      projectionWarnings: projections.flatMap((projection) => projectionWarningText(projection)),
    };
  } catch {
    return emptyCanonicalProjection(canonicalSource, [
      `canonical-config-invalid: ${displayPath} failed validation; launch will use provider start input only`,
    ]);
  }
}

/**
 * Outcome of the SY3 on-disk projection refresh that runs just before the
 * provider session (re)starts. `fingerprint` is the stable
 * `computeMossProjectionFingerprint` hash of the materialize result; `warnings`
 * carries any degraded-projection notices (A3) that must surface on the launch
 * plan without blocking the session.
 */
export interface MossLaunchPlanProjectionRefresh {
  /**
   * Stable projection fingerprint, or `null` when the refresh degraded (A3) so
   * the plan carries the warning but no fabricated fingerprint / generated
   * config source.
   */
  readonly fingerprint: string | null;
  readonly warnings?: ReadonlyArray<string> | undefined;
  /** Display path for the generated config source (defaults to the manifest). */
  readonly outputPath?: string | undefined;
}

export interface BuildMossLaunchPlanInput {
  readonly input: ProviderSessionStartInput;
  readonly createdAt?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly canonicalProjection?: MossLaunchPlanCanonicalProjection | null;
  readonly projectionRefresh?: MossLaunchPlanProjectionRefresh | null;
}

/**
 * Deterministic launch-plan id shared by `buildMossLaunchPlan` and the SY3
 * projection-refresh event correlation, so both derive one id from the same
 * `threadId`/`createdAt` inputs (no drift between the plan and its
 * `moss.config.projected` correlationId).
 */
export function makeMossLaunchPlanId(threadId: unknown, createdAt: string): string {
  const parsedTime = Date.parse(createdAt);
  return `moss-launch-${String(threadId)}-${Number.isFinite(parsedTime) ? parsedTime : createdAt}`;
}

export function buildMossLaunchPlan({
  input,
  createdAt = new Date().toISOString(),
  env = process.env,
  canonicalProjection = null,
  projectionRefresh = null,
}: BuildMossLaunchPlanInput): MossLaunchPlan {
  const provider = isProviderKind(input.provider) ? input.provider : "codex";
  const planId = makeMossLaunchPlanId(input.threadId, createdAt);
  const providerStartOptions = input.providerOptions
    ? redactRecord(input.providerOptions)
    : undefined;
  // The materialize fingerprint is folded into the plan two ways: a
  // `kind: "generated"` config source (so the planHash below covers it, A2) and
  // a top-level readable field. Degraded-projection notices (A3) join the
  // canonical projection warnings so the session still launches.
  const materializeConfigSource: MossConfigSource | null = projectionRefresh?.fingerprint
    ? {
        kind: "generated",
        ...(projectionRefresh.outputPath ? { path: projectionRefresh.outputPath } : {}),
        required: false,
        hash: projectionRefresh.fingerprint,
      }
    : null;
  const planWithoutHash = {
    version: 1 as const,
    planId,
    createdAt,
    provider,
    model: input.modelSelection?.model ?? null,
    workspace: {
      cwd: input.cwd ?? process.cwd(),
      threadId: input.threadId,
    },
    environment: {
      variables: launchPlanEnv(env),
    },
    permissions: {
      runtimeMode: input.runtimeMode,
      approvalPolicy: inferApprovalPolicy(input),
      sandboxMode: inferSandboxMode(input),
    },
    mcp: canonicalProjection?.mcp ?? [],
    skills: canonicalProjection?.skills ?? [],
    memory: canonicalProjection?.memory ?? [],
    hooks: canonicalProjection?.hooks ?? [],
    tools: canonicalProjection?.tools ?? EMPTY_TOOL_POLICY,
    ...(providerStartOptions ? { providerStartOptions } : {}),
    configSources: [
      ...(canonicalProjection?.configSources ?? []),
      ...(materializeConfigSource ? [materializeConfigSource] : []),
      {
        kind: "environment" as const,
        path: "process.env",
        required: false,
      },
    ],
    projectionWarnings: [
      ...(canonicalProjection?.projectionWarnings ?? []),
      ...(projectionRefresh?.warnings ?? []),
    ],
    ...(projectionRefresh?.fingerprint
      ? { projectionFingerprint: projectionRefresh.fingerprint }
      : {}),
  };

  return {
    ...planWithoutHash,
    planHash: hashValue(planWithoutHash),
  };
}

export function makeMossRuntimePayload(launchPlan: MossLaunchPlan): Record<string, unknown> {
  return {
    mossLaunchPlan: launchPlan,
    mossLaunchPlanHash: launchPlan.planHash,
  };
}

export function makeMossConfiguredEventId(launchPlan: MossLaunchPlan): string {
  return `moss-session-configured-${launchPlan.planHash.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
