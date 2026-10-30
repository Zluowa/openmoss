export interface GitHubReleaseState {
  readonly id: number;
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly publishedAt: string | null;
}

export interface FinalGitHubReleasePublication {
  readonly repository: string;
  readonly releaseId: number;
  readonly releaseTag: string;
  readonly targetCommitish: string;
  readonly releaseName: string;
  readonly releaseBody: string;
  readonly sourceRepository: string;
  readonly sourceCommit: string;
  readonly workflowRunId: string;
  readonly maxWorkflowRunAttempt: number;
  readonly prerelease: boolean;
  readonly makeLatest: "true" | "false" | "legacy";
}

export interface GitHubReleasePublicationClient {
  readonly readRelease: () => Promise<unknown>;
  readonly readLatestRelease: () => Promise<unknown>;
  readonly revalidateBeforePublish: () => Promise<void>;
  readonly publishRelease: () => Promise<unknown>;
  readonly waitBeforeRetry?: (attempt: number) => Promise<void>;
}

export interface GitHubReleasePublicationResult {
  readonly state: "already-published" | "published" | "recovered-after-ambiguous-response";
  readonly release: GitHubReleaseState;
}

interface PublicationOptions {
  readonly maxAttempts?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGitHubReleaseState(value: unknown): GitHubReleaseState {
  if (!isRecord(value)) {
    throw new Error("GitHub release response must be an object.");
  }
  const id = value.id;
  const tagName = value.tag_name;
  const targetCommitish = value.target_commitish;
  const name = value.name;
  const body = value.body;
  const draft = value.draft;
  const prerelease = value.prerelease;
  const publishedAt = value.published_at;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof tagName !== "string" ||
    typeof targetCommitish !== "string" ||
    typeof name !== "string" ||
    typeof body !== "string" ||
    typeof draft !== "boolean" ||
    typeof prerelease !== "boolean" ||
    (publishedAt !== null && typeof publishedAt !== "string")
  ) {
    throw new Error("GitHub release response is missing its exact publication identity.");
  }
  return { id, tagName, targetCommitish, name, body, draft, prerelease, publishedAt };
}

export function assertGitHubReleaseIdentity(
  release: GitHubReleaseState,
  expected: FinalGitHubReleasePublication,
): void {
  if (expected.releaseBody.length === 0) {
    throw new Error("Expected GitHub release body is required for exact publication validation.");
  }
  const bodyLines = release.body.split(/\r?\n/);
  const sourceLine = `- Source commit: https://github.com/${expected.sourceRepository}/commit/${expected.sourceCommit}`;
  const sourceLines = bodyLines.filter((line) => line.startsWith("- Source commit: "));
  const runLinePrefix = `- Build and acceptance run: https://github.com/${expected.sourceRepository}/actions/runs/${expected.workflowRunId}/attempts/`;
  const runLines = bodyLines.filter((line) => line.startsWith("- Build and acceptance run: "));
  const runAttemptText =
    runLines.length === 1 && runLines[0]?.startsWith(runLinePrefix)
      ? runLines[0].slice(runLinePrefix.length)
      : "";
  const runAttempt = Number(runAttemptText);
  if (
    release.id !== expected.releaseId ||
    release.tagName !== expected.releaseTag ||
    release.targetCommitish !== expected.targetCommitish ||
    release.name !== expected.releaseName ||
    release.body !== expected.releaseBody ||
    release.prerelease !== expected.prerelease ||
    sourceLines.length !== 1 ||
    sourceLines[0] !== sourceLine ||
    runLines.length !== 1 ||
    !/^[1-9][0-9]*$/.test(runAttemptText) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > expected.maxWorkflowRunAttempt
  ) {
    throw new Error(
      `GitHub release identity changed: expected ${expected.releaseId}/${expected.releaseTag}/target=${expected.targetCommitish}/prerelease=${expected.prerelease}.`,
    );
  }
}

function isConfirmedPublished(release: GitHubReleaseState): boolean {
  return release.draft === false && Boolean(release.publishedAt?.trim());
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function mustConfirmOfficialLatest(expected: FinalGitHubReleasePublication): boolean {
  return expected.prerelease === false && expected.makeLatest === "true";
}

async function confirmOfficialLatest(
  expected: FinalGitHubReleasePublication,
  client: GitHubReleasePublicationClient,
): Promise<void> {
  if (!mustConfirmOfficialLatest(expected)) return;
  const latest = parseGitHubReleaseState(await client.readLatestRelease());
  assertGitHubReleaseIdentity(latest, expected);
  if (!isConfirmedPublished(latest) || latest.prerelease) {
    throw new Error("GitHub releases/latest did not confirm the expected stable publication.");
  }
}

export async function publishGitHubReleaseFinal(
  expected: FinalGitHubReleasePublication,
  client: GitHubReleasePublicationClient,
  options: PublicationOptions = {},
): Promise<GitHubReleasePublicationResult> {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Final GitHub release publication requires at least one attempt.");
  }

  let lastFailure: unknown = new Error("GitHub release publication did not start.");
  let confirmedState: GitHubReleasePublicationResult["state"] | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let beforeResponse: unknown;
    try {
      beforeResponse = await client.readRelease();
    } catch (cause) {
      lastFailure = cause;
      if (attempt < maxAttempts) {
        await client.waitBeforeRetry?.(attempt);
        continue;
      }
      break;
    }
    const before = parseGitHubReleaseState(beforeResponse);
    assertGitHubReleaseIdentity(before, expected);

    if (isConfirmedPublished(before)) {
      try {
        await confirmOfficialLatest(expected, client);
      } catch (cause) {
        lastFailure = cause;
        if (attempt < maxAttempts) {
          await client.waitBeforeRetry?.(attempt);
          continue;
        }
        break;
      }
      await client.revalidateBeforePublish();
      return { state: confirmedState ?? "already-published", release: before };
    }
    if (!before.draft) {
      throw new Error("GitHub release is public without a confirmed published_at timestamp.");
    }

    // This is deliberately the final awaited operation before PATCH. Every
    // retry must re-prove the external source, tag, and indexed-asset
    // boundaries instead of relying on checks performed for an earlier
    // attempt.
    await client.revalidateBeforePublish();

    let publishedResponse: unknown;
    try {
      publishedResponse = await client.publishRelease();
    } catch (cause) {
      lastFailure = cause;

      // PATCH is idempotent. If its response was lost after GitHub applied the
      // mutation, a fresh read turns that ambiguous transport result into a
      // confirmed success instead of leaving a public release behind a red job.
      let recoveredResponse: unknown;
      try {
        recoveredResponse = await client.readRelease();
      } catch (readCause) {
        lastFailure = readCause;
        if (attempt < maxAttempts) {
          await client.waitBeforeRetry?.(attempt);
          continue;
        }
        break;
      }
      const recovered = parseGitHubReleaseState(recoveredResponse);
      assertGitHubReleaseIdentity(recovered, expected);
      if (isConfirmedPublished(recovered)) {
        confirmedState = "recovered-after-ambiguous-response";
        try {
          await confirmOfficialLatest(expected, client);
        } catch (cause) {
          lastFailure = cause;
          if (attempt < maxAttempts) {
            await client.waitBeforeRetry?.(attempt);
          }
          continue;
        }
        await client.revalidateBeforePublish();
        return { state: confirmedState, release: recovered };
      } else if (!recovered.draft) {
        throw new Error("GitHub release is public without a confirmed published_at timestamp.", {
          cause,
        });
      }

      if (attempt < maxAttempts) {
        await client.waitBeforeRetry?.(attempt);
      }
      continue;
    }

    const published = parseGitHubReleaseState(publishedResponse);
    assertGitHubReleaseIdentity(published, expected);
    if (isConfirmedPublished(published)) {
      confirmedState = "published";
      try {
        await confirmOfficialLatest(expected, client);
      } catch (cause) {
        lastFailure = cause;
        if (attempt < maxAttempts) {
          await client.waitBeforeRetry?.(attempt);
        }
        continue;
      }
      await client.revalidateBeforePublish();
      return { state: confirmedState, release: published };
    } else if (!published.draft) {
      throw new Error("GitHub release is public without a confirmed published_at timestamp.");
    } else {
      lastFailure = new Error("GitHub PATCH did not confirm a published release.");
    }

    if (attempt < maxAttempts) {
      await client.waitBeforeRetry?.(attempt);
    }
  }

  throw new Error(
    `Unable to confirm final GitHub release publication after ${maxAttempts} attempts: ${describeFailure(lastFailure)}`,
  );
}
