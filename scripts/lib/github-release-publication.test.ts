import { describe, expect, it, vi } from "vitest";

import {
  publishGitHubReleaseFinal as publishGitHubReleaseFinalUnderTest,
  type FinalGitHubReleasePublication,
  type GitHubReleasePublicationClient,
} from "./github-release-publication";

type PublicationArguments = Parameters<typeof publishGitHubReleaseFinalUnderTest>;
type TestPublicationClient = Omit<GitHubReleasePublicationClient, "revalidateBeforePublish"> &
  Partial<Pick<GitHubReleasePublicationClient, "revalidateBeforePublish">>;

function publishGitHubReleaseFinal(
  expected: PublicationArguments[0],
  client: TestPublicationClient,
  options?: PublicationArguments[2],
): ReturnType<typeof publishGitHubReleaseFinalUnderTest> {
  return publishGitHubReleaseFinalUnderTest(
    expected,
    {
      revalidateBeforePublish: async () => {},
      ...client,
    },
    options,
  );
}

const expectedReleaseBody = [
  "Moss v0.5.6 was produced from the reviewed source commit and workflow run below.",
  "",
  "## Source changes",
  "",
  "- Preserve exact release identity (`abc1234`)",
  "",
  "## Provenance",
  "",
  `- Source commit: https://github.com/Zluowa/Moss/commit/${"a".repeat(40)}`,
  "- Build and acceptance run: https://github.com/Zluowa/Moss/actions/runs/123/attempts/2",
  "",
  "Verify downloaded files against `SHA256SUMS`; `release-provenance.json` records the exact source and asset digests.",
].join("\n");

const expected: FinalGitHubReleasePublication = {
  repository: "Zluowa/moss-releases",
  releaseId: 123,
  releaseTag: "v0.5.6",
  targetCommitish: "main",
  releaseName: "Moss v0.5.6",
  releaseBody: expectedReleaseBody,
  sourceRepository: "Zluowa/Moss",
  sourceCommit: "a".repeat(40),
  workflowRunId: "123",
  maxWorkflowRunAttempt: 3,
  prerelease: false,
  makeLatest: "true",
};

const nonLatestCases = [
  { label: "make_latest=false", prerelease: false, makeLatest: "false" as const },
  { label: "legacy latest policy", prerelease: false, makeLatest: "legacy" as const },
  { label: "prerelease", prerelease: true, makeLatest: "true" as const },
] as const;

function release(draft: boolean, publishedAt: string | null = null): Record<string, unknown> {
  return {
    id: expected.releaseId,
    tag_name: expected.releaseTag,
    target_commitish: expected.targetCommitish,
    name: expected.releaseName,
    body: expected.releaseBody,
    draft,
    prerelease: expected.prerelease,
    published_at: publishedAt,
  };
}

describe("final GitHub release publication", () => {
  it("treats an exact already-public release as an idempotent success", async () => {
    const publishRelease = vi.fn();
    const readLatestRelease = vi.fn(async () => release(false, "2026-07-19T00:00:00Z"));
    const result = await publishGitHubReleaseFinal(expected, {
      readRelease: async () => release(false, "2026-07-19T00:00:00Z"),
      readLatestRelease,
      publishRelease,
    });

    expect(result.state).toBe("already-published");
    expect(publishRelease).not.toHaveBeenCalled();
    expect(readLatestRelease).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the publication boundary drifts before an already-public success return", async () => {
    const publishRelease = vi.fn();
    const revalidateBeforePublish = vi.fn(async () => {
      throw new Error("publication boundary drifted before success");
    });

    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          revalidateBeforePublish,
          publishRelease,
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow("publication boundary drifted before success");

    expect(revalidateBeforePublish).toHaveBeenCalledTimes(1);
    expect(publishRelease).not.toHaveBeenCalled();
  });

  it("publishes an exact draft and stops after the confirmed PATCH response", async () => {
    const readRelease = vi.fn(async () => release(true));
    const publishRelease = vi.fn(async () => release(false, "2026-07-19T00:00:00Z"));
    const result = await publishGitHubReleaseFinal(expected, {
      readRelease,
      readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
      publishRelease,
    });

    expect(result.state).toBe("published");
    expect(readRelease).toHaveBeenCalledTimes(1);
    expect(publishRelease).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the publication boundary drifts before a direct PATCH success return", async () => {
    let boundaryMatches = true;
    const events: string[] = [];
    const revalidateBeforePublish = vi.fn(async () => {
      events.push("revalidate");
      if (!boundaryMatches) {
        throw new Error("publication boundary drifted after PATCH");
      }
    });
    const publishRelease = vi.fn(async () => {
      events.push("patch");
      boundaryMatches = false;
      return release(false, "2026-07-19T00:00:00Z");
    });

    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease: async () => release(true),
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          revalidateBeforePublish,
          publishRelease,
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow("publication boundary drifted after PATCH");

    expect(events).toEqual(["revalidate", "patch", "revalidate"]);
    expect(publishRelease).toHaveBeenCalledTimes(1);
  });

  it("recovers success when the PATCH response is lost after publication", async () => {
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const result = await publishGitHubReleaseFinal(expected, {
      readRelease,
      readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
      publishRelease: async () => {
        throw new Error("connection reset after request");
      },
    });

    expect(result.state).toBe("recovered-after-ambiguous-response");
    expect(readRelease).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the publication boundary drifts before ambiguous PATCH recovery returns", async () => {
    let boundaryMatches = true;
    const events: string[] = [];
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const revalidateBeforePublish = vi.fn(async () => {
      events.push("revalidate");
      if (!boundaryMatches) {
        throw new Error("publication boundary drifted during ambiguous recovery");
      }
    });
    const publishRelease = vi.fn(async () => {
      events.push("patch");
      boundaryMatches = false;
      throw new Error("connection reset after request");
    });

    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease,
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          revalidateBeforePublish,
          publishRelease,
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow("publication boundary drifted during ambiguous recovery");

    expect(events).toEqual(["revalidate", "patch", "revalidate"]);
    expect(publishRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "draft",
      initial: {
        ...release(true),
        body: `${expectedReleaseBody}\nUnexpected mutable footer.`,
      },
    },
    {
      label: "published",
      initial: {
        ...release(false, "2026-07-19T00:00:00Z"),
        body: expectedReleaseBody.replace("## Source changes\n\n", ""),
      },
    },
  ])(
    "fails closed when an exact-provenance $label has drifted full body content",
    async ({ initial }) => {
      const publishRelease = vi.fn();
      const readLatestRelease = vi.fn();

      await expect(
        publishGitHubReleaseFinal(expected, {
          readRelease: async () => initial,
          readLatestRelease,
          publishRelease,
        }),
      ).rejects.toThrow("identity changed");

      expect(publishRelease).not.toHaveBeenCalled();
      expect(readLatestRelease).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "release id", override: { id: 999 } },
    { label: "tag", override: { tag_name: "v9.9.9" } },
    { label: "target commitish", override: { target_commitish: "other" } },
    { label: "name", override: { name: "Moss v9.9.9" } },
    { label: "body provenance", override: { body: "unattested" } },
    { label: "prerelease flag", override: { prerelease: true } },
  ])("fails closed on a parseable PATCH response with the wrong $label", async ({ override }) => {
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const readLatestRelease = vi.fn(async () => release(false, "2026-07-19T00:00:00Z"));
    const waitBeforeRetry = vi.fn();

    await expect(
      publishGitHubReleaseFinal(expected, {
        readRelease,
        readLatestRelease,
        publishRelease: async () => ({
          ...release(false, "2026-07-19T00:00:00Z"),
          ...override,
        }),
        waitBeforeRetry,
      }),
    ).rejects.toThrow("identity changed");

    expect(readRelease).toHaveBeenCalledTimes(1);
    expect(readLatestRelease).not.toHaveBeenCalled();
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it("fails closed on a parseable ambiguous-recovery read with the wrong identity", async () => {
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce({ ...release(false, "2026-07-19T00:00:00Z"), tag_name: "v9.9.9" });
    const waitBeforeRetry = vi.fn();

    await expect(
      publishGitHubReleaseFinal(expected, {
        readRelease,
        readLatestRelease: vi.fn(),
        publishRelease: async () => {
          throw new Error("connection reset after request");
        },
        waitBeforeRetry,
      }),
    ).rejects.toThrow("identity changed");

    expect(readRelease).toHaveBeenCalledTimes(2);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it("retries an unchanged draft with the same idempotent PATCH", async () => {
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(true));
    const publishRelease = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const result = await publishGitHubReleaseFinal(
      expected,
      {
        readRelease,
        readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
        publishRelease,
      },
      { maxAttempts: 2 },
    );

    expect(result.state).toBe("published");
    expect(publishRelease).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a second PATCH when a publication boundary drifts between attempts", async () => {
    let boundaryMatches = true;
    const events: string[] = [];
    const readRelease = vi.fn(async () => release(true));
    const publishRelease = vi.fn(async () => {
      events.push("patch");
      if (publishRelease.mock.calls.length === 1) {
        boundaryMatches = false;
        throw new Error("ambiguous transport failure");
      }
      return release(false, "2026-07-19T00:00:00Z");
    });
    const revalidateBeforePublish = vi.fn(async () => {
      events.push("revalidate");
      if (!boundaryMatches) {
        throw new Error("source main, public tag, or indexed assets drifted");
      }
    });

    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease,
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          revalidateBeforePublish,
          publishRelease,
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("source main, public tag, or indexed assets drifted");

    expect(events).toEqual(["revalidate", "patch", "revalidate"]);
    expect(publishRelease).toHaveBeenCalledTimes(1);
  });

  it("fails before mutation when the release identity changed", async () => {
    const publishRelease = vi.fn();
    const waitBeforeRetry = vi.fn();
    const readRelease = vi.fn(async () => ({ ...release(true), tag_name: "v9.9.9" }));
    await expect(
      publishGitHubReleaseFinal(expected, {
        readRelease,
        readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
        publishRelease,
        waitBeforeRetry,
      }),
    ).rejects.toThrow("identity changed");
    expect(readRelease).toHaveBeenCalledTimes(1);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
    expect(publishRelease).not.toHaveBeenCalled();
  });

  it("fails closed when GitHub never confirms publication", async () => {
    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease: async () => release(true),
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          publishRelease: async () => {
            throw new Error("unavailable");
          },
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("Unable to confirm final GitHub release publication");
  });

  it("retries until releases/latest confirms the exact stable release", async () => {
    const readRelease = vi
      .fn()
      .mockResolvedValueOnce(release(true))
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const readLatestRelease = vi
      .fn()
      .mockResolvedValueOnce({
        ...release(false, "2026-07-18T00:00:00Z"),
        id: 122,
        tag_name: "v0.5.5",
      })
      .mockResolvedValueOnce(release(false, "2026-07-19T00:00:00Z"));
    const result = await publishGitHubReleaseFinal(
      expected,
      {
        readRelease,
        readLatestRelease,
        publishRelease: async () => release(false, "2026-07-19T00:00:00Z"),
      },
      { maxAttempts: 2 },
    );

    expect(result.state).toBe("published");
    expect(readLatestRelease).toHaveBeenCalledTimes(2);
  });

  it("fails closed when releases/latest never matches the stable publication", async () => {
    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          readLatestRelease: async () => ({
            ...release(false, "2026-07-18T00:00:00Z"),
            id: 122,
            tag_name: "v0.5.5",
          }),
          publishRelease: vi.fn(),
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("Unable to confirm final GitHub release publication");
  });

  it.each(nonLatestCases)(
    "does not consult releases/latest for an existing public $label release",
    async ({ prerelease, makeLatest }) => {
      const nonLatestExpected = { ...expected, prerelease, makeLatest };
      const readLatestRelease = vi.fn();
      const result = await publishGitHubReleaseFinal(nonLatestExpected, {
        readRelease: async () => ({
          ...release(false, "2026-07-19T00:00:00Z"),
          prerelease,
        }),
        readLatestRelease,
        publishRelease: vi.fn(),
      });

      expect(result.state).toBe("already-published");
      expect(readLatestRelease).not.toHaveBeenCalled();
    },
  );

  it.each(nonLatestCases)(
    "does not consult releases/latest when directly publishing $label",
    async ({ prerelease, makeLatest }) => {
      const nonLatestExpected = { ...expected, prerelease, makeLatest };
      const readLatestRelease = vi.fn();
      const result = await publishGitHubReleaseFinal(nonLatestExpected, {
        readRelease: async () => ({ ...release(true), prerelease }),
        readLatestRelease,
        publishRelease: async () => ({
          ...release(false, "2026-07-19T00:00:00Z"),
          prerelease,
        }),
      });

      expect(result.state).toBe("published");
      expect(readLatestRelease).not.toHaveBeenCalled();
    },
  );

  it.each(nonLatestCases)(
    "does not consult releases/latest when recovering an ambiguous $label publication",
    async ({ prerelease, makeLatest }) => {
      const nonLatestExpected = { ...expected, prerelease, makeLatest };
      const readLatestRelease = vi.fn();
      const readRelease = vi
        .fn()
        .mockResolvedValueOnce({ ...release(true), prerelease })
        .mockResolvedValueOnce({
          ...release(false, "2026-07-19T00:00:00Z"),
          prerelease,
        });
      const result = await publishGitHubReleaseFinal(nonLatestExpected, {
        readRelease,
        readLatestRelease,
        publishRelease: async () => {
          throw new Error("connection reset after request");
        },
      });

      expect(result.state).toBe("recovered-after-ambiguous-response");
      expect(readLatestRelease).not.toHaveBeenCalled();
    },
  );

  it("fails before mutation when target_commitish changed", async () => {
    const publishRelease = vi.fn();
    await expect(
      publishGitHubReleaseFinal(
        expected,
        {
          readRelease: async () => ({ ...release(true), target_commitish: "other" }),
          readLatestRelease: async () => release(false, "2026-07-19T00:00:00Z"),
          publishRelease,
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow("identity changed");
    expect(publishRelease).not.toHaveBeenCalled();
  });
});
