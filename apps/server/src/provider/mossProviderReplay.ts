import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { Schema } from "effect";

import {
  MossNormalizedSessionEvent as MossNormalizedSessionEventSchema,
  MossNormalizedSessionEventType as MossNormalizedSessionEventTypeSchema,
  ProviderKind as ProviderKindSchema,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  type MossNormalizedSessionEvent,
  type MossNormalizedSessionEventType,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@synara/contracts";

import { MOSS_RELATIVE_PATHS } from "@synara/shared/mossSourceLayout";

import { normalizeProviderRuntimeEvents } from "./mossNormalizeEvent.ts";

const DEFAULT_FIXTURE_ROOT = MOSS_RELATIVE_PATHS.providerRuntimeFixturesRoot;

const decodeReplayFixture = Schema.decodeUnknownSync(
  Schema.Struct({
    provider: ProviderKindSchema,
    description: Schema.optional(Schema.String),
    expectedTypes: Schema.Array(MossNormalizedSessionEventTypeSchema),
    events: Schema.Array(ProviderRuntimeEventSchema),
  }),
);
const decodeNormalizedSessionEvent = Schema.decodeUnknownSync(MossNormalizedSessionEventSchema);

export type MossProviderReplayIssueCode =
  | "fixture-read-failed"
  | "fixture-invalid"
  | "empty-normalized-output"
  | "missing-normalized-type"
  | "missing-launch-plan-hash"
  | "normalized-event-invalid"
  | "provider-mismatch"
  | "raw-event-not-preserved";

export interface MossProviderReplayIssue {
  readonly code: MossProviderReplayIssueCode;
  readonly fixturePath: string;
  readonly message: string;
  readonly eventId?: string;
  readonly type?: MossNormalizedSessionEventType;
}

export interface MossProviderReplayFixture {
  readonly provider: ProviderKind;
  readonly description?: string | undefined;
  readonly expectedTypes: ReadonlyArray<MossNormalizedSessionEventType>;
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
}

export interface MossProviderReplayFixtureReport {
  readonly provider: ProviderKind | null;
  readonly fixturePath: string;
  readonly rawEventCount: number;
  readonly normalizedEventCount: number;
  readonly expectedTypes: ReadonlyArray<MossNormalizedSessionEventType>;
  readonly observedTypes: ReadonlyArray<MossNormalizedSessionEventType>;
  readonly missingTypes: ReadonlyArray<MossNormalizedSessionEventType>;
  readonly rawEventIds: ReadonlyArray<string>;
  readonly normalizedEventIds: ReadonlyArray<string>;
  readonly normalizedEvents: ReadonlyArray<MossNormalizedSessionEvent>;
  readonly issues: ReadonlyArray<MossProviderReplayIssue>;
}

export interface MossProviderReplayGate {
  readonly status: "pass" | "fail";
  readonly issueCount: number;
  readonly issues: ReadonlyArray<MossProviderReplayIssue>;
}

export interface MossProviderReplayReport {
  readonly generatedAt: string;
  readonly fixtureRoot: string;
  readonly fixtures: ReadonlyArray<MossProviderReplayFixtureReport>;
  readonly releaseGate: MossProviderReplayGate;
}

export interface MossProviderReplayOptions {
  readonly fixtureRoot?: string;
  readonly createdAt?: string;
}

function issue(
  code: MossProviderReplayIssueCode,
  fixturePath: string,
  message: string,
  detail: Partial<Pick<MossProviderReplayIssue, "eventId" | "type">> = {},
): MossProviderReplayIssue {
  return {
    code,
    fixturePath,
    message,
    ...detail,
  };
}

function uniqueEventTypes(
  events: ReadonlyArray<MossNormalizedSessionEvent>,
): ReadonlyArray<MossNormalizedSessionEventType> {
  const seen = new Set<MossNormalizedSessionEventType>();
  const types: MossNormalizedSessionEventType[] = [];
  for (const event of events) {
    if (!seen.has(event.type)) {
      seen.add(event.type);
      types.push(event.type);
    }
  }
  return types;
}

function normalizedPayloadRecord(event: MossNormalizedSessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function emptyFixtureReport(
  fixturePath: string,
  issues: ReadonlyArray<MossProviderReplayIssue>,
): MossProviderReplayFixtureReport {
  return {
    provider: null,
    fixturePath,
    rawEventCount: 0,
    normalizedEventCount: 0,
    expectedTypes: [],
    observedTypes: [],
    missingTypes: [],
    rawEventIds: [],
    normalizedEventIds: [],
    normalizedEvents: [],
    issues,
  };
}

function parseFixture(content: string, fixturePath: string): MossProviderReplayFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${fixturePath}: invalid JSON: ${String(error)}`, { cause: error });
  }

  try {
    return decodeReplayFixture(parsed);
  } catch (error) {
    throw new Error(`${fixturePath}: invalid provider replay fixture: ${String(error)}`, {
      cause: error,
    });
  }
}

function summarizeFixture(
  fixture: MossProviderReplayFixture,
  fixturePath: string,
): MossProviderReplayFixtureReport {
  const issues: MossProviderReplayIssue[] = [];
  const rawEventIds = fixture.events.map((event) => event.eventId);
  let normalizedEvents: ReadonlyArray<MossNormalizedSessionEvent> = [];

  try {
    normalizedEvents = normalizeProviderRuntimeEvents(fixture.events).map((event) =>
      decodeNormalizedSessionEvent(event),
    );
  } catch (error) {
    issues.push(
      issue(
        "normalized-event-invalid",
        fixturePath,
        `normalized event decode failed: ${String(error)}`,
      ),
    );
  }

  if (normalizedEvents.length === 0) {
    issues.push(
      issue("empty-normalized-output", fixturePath, "fixture produced no normalized events"),
    );
  }

  const observedTypes = uniqueEventTypes(normalizedEvents);
  const missingTypes = fixture.expectedTypes.filter((type) => !observedTypes.includes(type));
  for (const type of missingTypes) {
    issues.push(
      issue("missing-normalized-type", fixturePath, `fixture did not produce normalized ${type}`, {
        type,
      }),
    );
  }

  for (const event of normalizedEvents) {
    if (event.provider !== fixture.provider) {
      issues.push(
        issue(
          "provider-mismatch",
          fixturePath,
          `normalized event provider ${event.provider} does not match fixture provider ${fixture.provider}`,
          { eventId: event.eventId },
        ),
      );
    }
    if (!event.rawEventId || !rawEventIds.includes(event.rawEventId)) {
      issues.push(
        issue(
          "raw-event-not-preserved",
          fixturePath,
          `normalized event ${event.eventId} does not preserve a known raw event id`,
          { eventId: event.eventId },
        ),
      );
    }

    const launchPlanHash = normalizedPayloadRecord(event).launchPlanHash;
    if (typeof launchPlanHash !== "string" || launchPlanHash.trim().length === 0) {
      issues.push(
        issue(
          "missing-launch-plan-hash",
          fixturePath,
          `normalized event ${event.eventId} does not preserve launchPlanHash`,
          { eventId: event.eventId },
        ),
      );
    }
  }

  return {
    provider: fixture.provider,
    fixturePath,
    rawEventCount: fixture.events.length,
    normalizedEventCount: normalizedEvents.length,
    expectedTypes: fixture.expectedTypes,
    observedTypes,
    missingTypes,
    rawEventIds,
    normalizedEventIds: normalizedEvents.map((event) => event.eventId),
    normalizedEvents,
    issues,
  };
}

async function replayFixtureFile(
  absolutePath: string,
  fixturePath: string,
): Promise<MossProviderReplayFixtureReport> {
  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    return emptyFixtureReport(fixturePath, [
      issue("fixture-read-failed", fixturePath, `fixture could not be read: ${String(error)}`),
    ]);
  }

  try {
    return summarizeFixture(parseFixture(content, fixturePath), fixturePath);
  } catch (error) {
    return emptyFixtureReport(fixturePath, [issue("fixture-invalid", fixturePath, String(error))]);
  }
}

async function listFixtureFiles(fixtureRoot: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .toSorted();
}

export async function readMossProviderReplayReport(
  repoRoot = process.cwd(),
  options: MossProviderReplayOptions = {},
): Promise<MossProviderReplayReport> {
  const generatedAt = options.createdAt ?? new Date().toISOString();
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const absoluteFixtureRoot = join(repoRoot, fixtureRoot);
  let fixtureFiles: ReadonlyArray<string>;

  try {
    fixtureFiles = await listFixtureFiles(absoluteFixtureRoot);
  } catch (error) {
    const rootIssue = issue(
      "fixture-read-failed",
      fixtureRoot,
      `fixture root could not be read: ${String(error)}`,
    );
    return {
      generatedAt,
      fixtureRoot,
      fixtures: [],
      releaseGate: {
        status: "fail",
        issueCount: 1,
        issues: [rootIssue],
      },
    };
  }

  const fixtures = await Promise.all(
    fixtureFiles.map((filename) =>
      replayFixtureFile(
        join(absoluteFixtureRoot, filename),
        relative(repoRoot, join(absoluteFixtureRoot, filename)),
      ),
    ),
  );
  const fixtureIssues = fixtures.flatMap((fixture) => fixture.issues);
  const allIssues =
    fixtures.length === 0
      ? [
          issue(
            "fixture-read-failed",
            fixtureRoot,
            "fixture root does not contain any provider runtime JSON fixtures",
          ),
        ]
      : fixtureIssues;

  return {
    generatedAt,
    fixtureRoot,
    fixtures,
    releaseGate: {
      status: allIssues.length === 0 ? "pass" : "fail",
      issueCount: allIssues.length,
      issues: allIssues,
    },
  };
}

export function mossProviderReplayExitCode(report: MossProviderReplayReport): number {
  return report.releaseGate.status === "pass" ? 0 : 1;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossProviderReplayOptions {
  const options: { fixtureRoot?: string; createdAt?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture-root") {
      const fixtureRoot = argv[index + 1];
      if (!fixtureRoot) {
        throw new Error("--fixture-root requires a path");
      }
      options.fixtureRoot = fixtureRoot;
      index += 1;
      continue;
    }
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    throw new Error(`unknown moss provider replay option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const report = await readMossProviderReplayReport(
    process.cwd(),
    parseCliOptions(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = mossProviderReplayExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
