/**
 * Moss hook executor (ported from 1code `moss-source/hooks.ts`).
 *
 * Runs `.moss/hooks/*.md` commands for a runtime event (canonically
 * `MossSessionStart`) with the exact 1code execution semantics: shell spawn
 * with a hard timeout (SIGTERM, then SIGKILL after 2s), captured and
 * secret-redacted stdout/stderr, a sha256 `payloadHash` over the hook payload,
 * and per-hook `commandHash` fingerprints. Hook scripts receive the same
 * `MOSS_HOOK_*` environment contract as 1code, so a hook written for either
 * host runs unchanged in the other.
 *
 * Moss-specific deviations (semantic rewrite, disclosed):
 * - `engineId: AgentEngineId` becomes `provider: ProviderKind` — the moss
 *   provider id is what `MOSS_HOOK_ENGINE` carries.
 * - Discovery is a minimal `.moss/hooks` scan ({@link discoverMossHooks})
 *   instead of 1code's full shared-resource registry. Trust state is a
 *   REQUIRED field: 1code's "absent trust metadata is treated as trusted"
 *   compatibility branch is dropped (moss has no legacy callers), so every
 *   hook is fail-closed until `.moss/hooks/.trust.json` records its current
 *   hash.
 * - Frontmatter is parsed with the shared YAML reader (`frontmatter.ts`),
 *   not gray-matter. Multi-line `command:` values (a literal `|` block, or a
 *   bare marker left by the line-reader fallback) are unsupported and
 *   normalize to "no command", so the hook is skipped rather than run as a
 *   multi-line script (fail-closed).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderKind } from "@synara/contracts";

import { parseFrontmatterScalars } from "./frontmatter";
import { resolveWindowsSystemExecutable } from "./platformEnvironment";
import { execProcessFile } from "./processRuntime";
import {
  computeHookTrustHash,
  readHookTrustStore,
  resolveHookTrustState,
  type MossHookTrustState,
} from "./mossHookTrust";
import { getMossSourceLayout, toMossProjectPath } from "./mossSourceLayout";

export type MossHookRunStatus = "passed" | "failed" | "skipped" | "timed-out";

/**
 * Canonical Moss SessionStart event name — the single literal source for the
 * whole monorepo (the starter hook frontmatter, the bootstrap constant, and
 * the server session-start pipeline all reference this value). Keeping one
 * source of truth avoids the historical 1code Hermes/Moss event-name mismatch
 * where a runtime event never matched the starter hook after normalization.
 */
export const MOSS_SESSION_START_EVENT = "MossSessionStart";

/** Default per-hook wall-clock budget before SIGTERM (then SIGKILL after 2s). */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_HOOKS = 20;
const FORCE_KILL_GRACE_MS = 2_000;
const MAX_VISIBLE_OUTPUT_CHARS = 4_000;

/** A single `.moss/hooks/*.md` entry as seen by the runtime executor. */
export interface MossHookResource {
  /** Stable id, `moss:hook:<name>` (mirrors the 1code registry id shape). */
  readonly id: string;
  readonly name: string;
  /** Project-relative path of the hook markdown file. */
  readonly path: string;
  /** Effective event the hook fires on (frontmatter `event`, `"Stop"` fallback as in 1code). */
  readonly event: string;
  readonly command?: string;
  readonly enabled: boolean;
  readonly description?: string;
  /** Current content hash (command+event) used by the trust gate. */
  readonly trustHash: string;
  /**
   * Runtime trust gate input — REQUIRED. Only `trusted` hooks may spawn;
   * `untrusted` and `changed` are skipped without spawning (fail-closed).
   */
  readonly trustState: MossHookTrustState;
}

export interface MossHookRunResult {
  resourceId: string;
  name: string;
  event: string;
  status: MossHookRunStatus;
  command?: string | undefined;
  commandHash?: string | undefined;
  exitCode?: number | null | undefined;
  elapsedMs: number;
  stdout?: string | undefined;
  stderr?: string | undefined;
  error?: string | undefined;
  timedOut?: boolean | undefined;
}

export interface MossHookRunSummary {
  status: MossHookRunStatus;
  event: string;
  provider: ProviderKind;
  projectPath: string;
  matchedCount: number;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  timedOutCount: number;
  payloadHash: string;
  results: MossHookRunResult[];
  warnings: string[];
}

export interface RunMossHooksOptions {
  projectPath: string;
  event: string;
  provider: ProviderKind;
  cwd?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  env?: Record<string, string | undefined> | undefined;
  timeoutMs?: number | undefined;
  maxHooks?: number | undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEvent(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Redacts common secret shapes (`sk-…` keys, `Bearer` tokens, `key=value`
 * credential assignments) and bounds output to 4000 chars. Applied to every
 * command/stdout/stderr/error surface before it leaves this module, so run
 * summaries are safe to log verbatim.
 */
export function redactHookOutput(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer REDACTED")
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\n}]+)/gi,
      "$1REDACTED",
    )
    .slice(0, MAX_VISIBLE_OUTPUT_CHARS);
}

function isSafeEntryName(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function readScalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** YAML block-scalar markers our scalar parser cannot follow; see module doc. */
const YAML_BLOCK_SCALAR_MARKER = /^[|>][+-]?$/;

function readHookCommand(value: unknown): string | undefined {
  const command = readScalarString(value);
  if (!command || YAML_BLOCK_SCALAR_MARKER.test(command) || /[\r\n]/.test(command)) {
    return undefined;
  }
  return command;
}

/**
 * Minimal `.moss/hooks` discovery: scans `*.md` files directly under the
 * hooks root (directories and unsafe names are ignored), extracts scalar
 * frontmatter, and resolves the trust state of every hook against
 * `.moss/hooks/.trust.json`.
 *
 * A missing hooks root yields `[]`; any other filesystem error propagates so
 * `runMossHooks` can surface a `moss:hooks` discovery failure result.
 */
export async function discoverMossHooks(projectPath: string): Promise<MossHookResource[]> {
  const layout = getMossSourceLayout(projectPath);

  let entries;
  try {
    entries = await readdir(layout.hooksRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const trustStore = await readHookTrustStore(projectPath);
  const resources: MossHookResource[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || !isSafeEntryName(entry.name)) {
      continue;
    }

    const filePath = join(layout.hooksRoot, entry.name);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatterScalars(raw);
    const name = readScalarString(frontmatter.name) ?? entry.name.replace(/\.md$/, "");
    // The trust hash covers the RAW frontmatter event (undefined -> ""), while
    // event matching applies the 1code "Stop" fallback — mirroring how the
    // 1code registry hashes `parsed.data.event` before its display fallback.
    const rawEvent = readScalarString(frontmatter.event);
    const command = readHookCommand(frontmatter.command);
    const trustHash = computeHookTrustHash({
      ...(command !== undefined ? { command } : {}),
      ...(rawEvent !== undefined ? { event: rawEvent } : {}),
    });
    const description = readScalarString(frontmatter.description);

    resources.push({
      id: `moss:hook:${name}`,
      name,
      path: toMossProjectPath(projectPath, filePath),
      event: rawEvent ?? "Stop",
      ...(command !== undefined ? { command } : {}),
      enabled: frontmatter.enabled !== false,
      ...(description !== undefined ? { description } : {}),
      trustHash,
      trustState: resolveHookTrustState({
        currentHash: trustHash,
        entry: trustStore.hooks[name],
      }),
    });
  }

  return resources;
}

/**
 * Runtime trust gate (1code S4.4 semantics): a hook may only spawn when it is
 * `trusted` — explicitly trusted at its CURRENT command/event hash. Newly
 * discovered (`untrusted`) and edited-since-trust (`changed`) hooks are
 * reported `skipped` and never spawn.
 */
function hookTrustSkipReason(resource: MossHookResource): string | null {
  if (resource.trustState === "trusted") return null;
  if (resource.trustState === "changed") {
    return "Hook changed since last trusted.";
  }
  return "Hook is not trusted.";
}

function visibleResult(result: MossHookRunResult): MossHookRunResult {
  return {
    ...result,
    command: result.command ? redactHookOutput(result.command) : undefined,
    stdout: result.stdout ? redactHookOutput(result.stdout) : undefined,
    stderr: result.stderr ? redactHookOutput(result.stderr) : undefined,
    error: result.error ? redactHookOutput(result.error) : undefined,
  };
}

async function terminateHookProcess(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return;
  }
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // The live ChildProcess owns this PID. Killing cmd.exe alone leaves the
    // hook's descendants running with our captured stdout/stderr pipes open.
    await new Promise<void>((resolve, reject) => {
      execProcessFile(
        resolveWindowsSystemExecutable(["System32", "taskkill.exe"]),
        ["/pid", String(pid), "/T", "/F"],
        { encoding: "utf8", timeout: 5_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ESRCH") {
        return;
      }
    }
  }

  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function runHookCommand(params: {
  resource: MossHookResource;
  command: string;
  event: string;
  provider: ProviderKind;
  projectPath: string;
  cwd: string;
  payloadJson: string;
  payloadHash: string;
  env?: Record<string, string | undefined> | undefined;
  timeoutMs: number;
}): Promise<MossHookRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(params.command, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env,
        // The 8-variable MOSS_HOOK_* contract is kept verbatim from 1code so
        // hook scripts are portable across hosts. MOSS_HOOK_ENGINE carries the
        // moss ProviderKind.
        MOSS_HOOK_EVENT: params.event,
        MOSS_HOOK_ENGINE: params.provider,
        MOSS_HOOK_RESOURCE_ID: params.resource.id,
        MOSS_HOOK_NAME: params.resource.name,
        MOSS_HOOK_PROJECT_PATH: params.projectPath,
        MOSS_HOOK_CWD: params.cwd,
        MOSS_HOOK_PAYLOAD_JSON: params.payloadJson,
        MOSS_HOOK_PAYLOAD_SHA256: params.payloadHash,
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let termination: Promise<void> | undefined;
    let terminationError: string | undefined;

    const terminate = (signal: NodeJS.Signals): Promise<void> =>
      terminateHookProcess(child, signal).catch((error: unknown) => {
        terminationError = error instanceof Error ? error.message : String(error);
      });

    const timeout = setTimeout(() => {
      timedOut = true;
      termination = terminate("SIGTERM");
      forceKillTimer = setTimeout(() => {
        // Do not overlap Windows tree helpers or signal a completed root.
        void termination?.then(() => terminate("SIGKILL"));
      }, FORCE_KILL_GRACE_MS);
    }, params.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(
        visibleResult({
          resourceId: params.resource.id,
          name: params.resource.name,
          event: params.event,
          status: "failed",
          command: params.command,
          commandHash: sha256(params.command),
          elapsedMs: Date.now() - startedAt,
          error: error.message,
        }),
      );
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const status: MossHookRunStatus = timedOut
        ? "timed-out"
        : exitCode === 0
          ? "passed"
          : "failed";

      resolve(
        visibleResult({
          resourceId: params.resource.id,
          name: params.resource.name,
          event: params.event,
          status,
          command: params.command,
          commandHash: sha256(params.command),
          exitCode,
          elapsedMs: Date.now() - startedAt,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
          stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
          timedOut,
          error: terminationError,
        }),
      );
    });
  });
}

/**
 * Runs every enabled, trusted `.moss` hook matching `options.event`
 * (case-insensitively) and returns a fully redacted run summary. Never
 * rejects: discovery failures become a synthetic `moss:hooks` failed result,
 * and per-hook failures/timeouts are isolated per result.
 */
export async function runMossHooks(options: RunMossHooksOptions): Promise<MossHookRunSummary> {
  const payloadJson = JSON.stringify(options.payload ?? {});
  const payloadHash = sha256(payloadJson);
  const warnings: string[] = [];
  const event = options.event.trim();
  const normalizedEvent = normalizeEvent(event);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const maxHooks = options.maxHooks ?? DEFAULT_MAX_HOOKS;

  let resources: MossHookResource[] = [];
  try {
    resources = await discoverMossHooks(options.projectPath);
  } catch (error) {
    return {
      status: "failed",
      event,
      provider: options.provider,
      projectPath: options.projectPath,
      matchedCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      timedOutCount: 0,
      payloadHash,
      results: [
        {
          resourceId: "moss:hooks",
          name: "Moss hook discovery",
          event,
          status: "failed",
          elapsedMs: 0,
          error: redactHookOutput(error instanceof Error ? error.message : String(error)),
        },
      ],
      warnings,
    };
  }

  const allMatches = resources.filter(
    (resource) => normalizeEvent(resource.event) === normalizedEvent,
  );
  const matchedHooks = allMatches.slice(0, maxHooks);

  if (allMatches.length > matchedHooks.length) {
    warnings.push(
      `Moss hook run limited to ${matchedHooks.length} of ${allMatches.length} matching hooks.`,
    );
  }

  const results: MossHookRunResult[] = [];
  for (const resource of matchedHooks) {
    if (!resource.enabled) {
      results.push({
        resourceId: resource.id,
        name: resource.name,
        event,
        status: "skipped",
        elapsedMs: 0,
        error: "Hook is disabled.",
      });
      continue;
    }

    const trustSkipReason = hookTrustSkipReason(resource);
    if (trustSkipReason) {
      results.push({
        resourceId: resource.id,
        name: resource.name,
        event,
        status: "skipped",
        elapsedMs: 0,
        error: trustSkipReason,
      });
      continue;
    }

    const command = resource.command;
    if (!command) {
      results.push({
        resourceId: resource.id,
        name: resource.name,
        event,
        status: "skipped",
        elapsedMs: 0,
        error: "Hook has no command.",
      });
      continue;
    }

    results.push(
      await runHookCommand({
        resource,
        command,
        event,
        provider: options.provider,
        projectPath: options.projectPath,
        cwd: options.cwd ?? options.projectPath,
        payloadJson,
        payloadHash,
        env: options.env,
        timeoutMs,
      }),
    );
  }

  const executedCount = results.filter((result) =>
    ["passed", "failed", "timed-out"].includes(result.status),
  ).length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const timedOutCount = results.filter((result) => result.status === "timed-out").length;
  const status: MossHookRunStatus =
    failedCount > 0 || timedOutCount > 0 ? "failed" : executedCount > 0 ? "passed" : "skipped";

  return {
    status,
    event,
    provider: options.provider,
    projectPath: options.projectPath,
    matchedCount: matchedHooks.length,
    executedCount,
    skippedCount,
    failedCount,
    timedOutCount,
    payloadHash,
    results,
    warnings,
  };
}
